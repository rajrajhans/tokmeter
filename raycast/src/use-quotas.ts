import { useMemo } from "react";
import { getPreferenceValues } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { present, type UsageView } from "./lib/model";
import { fetchTokmeter } from "./lib/tokmeter";

type Preferences = {
  binaryPath?: string;
  includeStats?: boolean;
};

export function useQuotas(): {
  isLoading: boolean;
  view: UsageView | undefined;
  failure: string | undefined;
  revalidate: () => void;
} {
  const prefs = getPreferenceValues<Preferences>();
  const binaryPath = prefs.binaryPath?.trim() ?? "";
  const includeStats = prefs.includeStats === true;
  const { isLoading, data, error, revalidate } = useCachedPromise(
    fetchTokmeter,
    [binaryPath, includeStats],
    {
      keepPreviousData: true,
      onError: () => {
        // The dashboard shows failures inline; a duplicate toast would hide useful data.
      },
    },
  );

  const view = useMemo(() => data ? present(data) : undefined, [data]);
  return {
    isLoading,
    view,
    failure: error instanceof Error ? error.message : undefined,
    revalidate,
  };
}
