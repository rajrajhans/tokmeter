{
  description = "tokmeter — unified Claude Code, Codex, and Grok usage CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        inherit (pkgs) lib;

        src = lib.cleanSourceWith {
          src = ./.;
          filter =
            path: type:
            let
              base = baseNameOf path;
            in
            !(lib.hasInfix "/node_modules" path)
            && !(lib.hasInfix "/dist" path)
            && !(lib.hasInfix "/.git" path)
            && !(lib.hasInfix "/.direnv" path)
            && !(lib.hasInfix "/.tokmeter-cache" path)
            && base != "result"
            && base != "result-bin";
        };

        # Installable release build: single ESM bundle, zero npm at runtime.
        tokmeter = pkgs.stdenvNoCC.mkDerivation {
          pname = "tokmeter";
          version = "0.1.0";
          inherit src;

          nativeBuildInputs = [
            pkgs.esbuild
            pkgs.makeWrapper
          ];

          buildPhase = ''
            runHook preBuild
            esbuild src/index.ts \
              --bundle \
              --platform=node \
              --format=esm \
              --target=node20 \
              --packages=external \
              --outfile=tokmeter.mjs
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/tokmeter $out/bin
            cp tokmeter.mjs $out/lib/tokmeter/tokmeter.mjs
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/tokmeter \
              --add-flags "$out/lib/tokmeter/tokmeter.mjs"
            runHook postInstall
          '';

          meta = with lib; {
            description = "Unified CLI for Claude Code, OpenAI Codex, and Grok usage";
            homepage = "https://github.com/rajrajhans/tokmeter";
            license = licenses.mit;
            mainProgram = "tokmeter";
            platforms = platforms.unix;
          };
        };

        # Dev binary: rebuilds live workspace sources with esbuild (no npm, never writes to /nix/store).
        tokmeter-dev = pkgs.writeShellApplication {
          name = "tokmeter";
          runtimeInputs = [
            pkgs.nodejs_22
            pkgs.esbuild
            pkgs.coreutils
            pkgs.findutils
          ];
          text = ''
            set -euo pipefail

            is_writable_project_root() {
              local d="$1"
              [[ -n "$d" ]] \
                && [[ "$d" != /nix/store/* ]] \
                && [[ -f "$d/flake.nix" ]] \
                && [[ -f "$d/src/index.ts" ]] \
                && [[ -f "$d/package.json" ]] \
                && [[ -w "$d" ]]
            }

            find_project_root() {
              # 1) explicit env (only if usable)
              if is_writable_project_root "''${TOKMETER_ROOT:-}"; then
                printf '%s\n' "$(cd "$TOKMETER_ROOT" && pwd -P)"
                return 0
              fi

              # 2) walk up from cwd
              local dir
              dir="$(pwd -P)"
              while [[ "$dir" != "/" ]]; do
                if is_writable_project_root "$dir"; then
                  printf '%s\n' "$dir"
                  return 0
                fi
                dir="$(dirname "$dir")"
              done

              return 1
            }

            root="$(find_project_root)" || {
              echo "tokmeter (dev): could not find a writable checkout." >&2
              echo "  cd into ~/…/tokmeter and re-enter the shell (direnv allow / nix develop)." >&2
              echo "  Or run the release binary: nix run . / tokmeter-release" >&2
              if [[ -n "''${TOKMETER_ROOT:-}" ]]; then
                echo "  (ignoring TOKMETER_ROOT=$TOKMETER_ROOT — store path or not writable)" >&2
              fi
              exit 1
            }

            # Cache outside the tree so pure flakes / direnv never need store writes.
            cache_root="''${XDG_CACHE_HOME:-$HOME/.cache}/tokmeter-dev"
            mkdir -p "$cache_root"

            # Rebuild when any .ts source changes (cheap fingerprint).
            # Portable: prefer shasum/sha256sum if present, else esbuild every time.
            stamp_file="$cache_root/src.stamp"
            out_js="$cache_root/tokmeter.mjs"
            if command -v shasum >/dev/null 2>&1; then
              hash_cmd=(shasum -a 256)
            else
              hash_cmd=(sha256sum)
            fi
            new_stamp="$(
              find "$root/src" -type f -name '*.ts' -print0 \
                | sort -z \
                | xargs -0 cat 2>/dev/null \
                | "''${hash_cmd[@]}" \
                | awk '{print $1}'
            )"

            need_build=1
            if [[ -f "$out_js" && -f "$stamp_file" ]]; then
              old_stamp="$(cat "$stamp_file" 2>/dev/null || true)"
              if [[ "$old_stamp" == "$new_stamp" && -n "$new_stamp" ]]; then
                need_build=0
              fi
            fi

            if [[ "$need_build" -eq 1 ]]; then
              esbuild "$root/src/index.ts" \
                --bundle \
                --platform=node \
                --format=esm \
                --target=node20 \
                --packages=external \
                --outfile="$out_js"
              printf '%s\n' "$new_stamp" >"$stamp_file"
            fi

            exec node "$out_js" "$@"
          '';
        };
      in
      {
        packages = {
          default = tokmeter;
          tokmeter = tokmeter;
        };

        apps = {
          default = {
            type = "app";
            program = "${tokmeter}/bin/tokmeter";
          };
          tokmeter = {
            type = "app";
            program = "${tokmeter}/bin/tokmeter";
          };
          release = {
            type = "app";
            program = "${tokmeter}/bin/tokmeter";
          };
        };

        # `nix develop` / direnv: live `tokmeter` only.
        # Do NOT pull `packages.default` into the shell — flake source is
        # git-tracked-only, so uncommitted files would break `direnv allow`.
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.typescript
            pkgs.esbuild
            tokmeter-dev
          ];

          shellHook = ''
            # Drop any stale TOKMETER_ROOT from an older shellHook that pointed
            # at /nix/store/...-source (read-only → EACCES on npm install).
            if [[ -n "''${TOKMETER_ROOT:-}" ]] && [[ "$TOKMETER_ROOT" == /nix/store/* || ! -w "''${TOKMETER_ROOT:-/}" ]]; then
              unset TOKMETER_ROOT
            fi

            # Prefer the real workspace direnv / nix develop was entered from.
            if [[ -f "$PWD/flake.nix" && -f "$PWD/src/index.ts" && -w "$PWD" && "$PWD" != /nix/store/* ]]; then
              export TOKMETER_ROOT="$(pwd -P)"
            fi

            echo "tokmeter dev shell ready (node $(node --version))"
            echo "  tokmeter           → live src (esbuild cache, no npm)''${TOKMETER_ROOT:+ · $TOKMETER_ROOT}"
            echo "  nix run .          → release build (git-tracked sources)"
            echo "  nix profile install .  → install release binary"
          '';
        };

        checks.tokmeter = tokmeter;
      }
    );
}
