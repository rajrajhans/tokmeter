function run(argv) {
  ObjC.import("Cocoa");
  const specPath = argv[0];
  const outPath = argv[1];
  if (!specPath || !outPath) throw new Error("draw.js needs a spec path and an output path");

  const raw = $.NSString.stringWithContentsOfFileEncodingError(
    specPath,
    $.NSUTF8StringEncoding,
    null,
  );
  if (!raw) throw new Error("could not read the board spec");
  const spec = JSON.parse(raw.js);
  const scale = spec.scale || 2;
  const width = Math.round(spec.width * scale);
  const height = Math.round(spec.height * scale);

  const rep =
    $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null,
      width,
      height,
      8,
      4,
      true,
      false,
      $.NSCalibratedRGBColorSpace,
      0,
      0,
    );
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.setCurrentContext(ctx);
  $.NSColor.clearColor.set;
  $.NSBezierPath.fillRect($.NSMakeRect(0, 0, width, height));

  function rgba(hex, alpha) {
    const n = parseInt(String(hex).slice(1), 16);
    return $.NSColor.colorWithCalibratedRedGreenBlueAlpha(
      ((n >> 16) & 255) / 255,
      ((n >> 8) & 255) / 255,
      (n & 255) / 255,
      alpha == null ? 1 : alpha,
    );
  }

  function font(size, weight) {
    const px = size * scale;
    if (weight === "semibold") return $.NSFont.systemFontOfSizeWeight(px, $.NSFontWeightSemibold);
    if (weight === "medium") return $.NSFont.systemFontOfSizeWeight(px, $.NSFontWeightMedium);
    return $.NSFont.systemFontOfSize(px);
  }

  function drawText(op) {
    const face = font(op.size, op.weight);
    const attrs = $.NSMutableDictionary.alloc.init;
    attrs.setObjectForKey(face, $.NSFontAttributeName);
    attrs.setObjectForKey(rgba(op.color, op.alpha), $.NSForegroundColorAttributeName);
    const s = $.NSString.alloc.initWithUTF8String(String(op.text));
    const measured = s.sizeWithAttributes(attrs).width;
    let x = op.x * scale;
    if (op.align === "right") x -= measured;
    else if (op.align === "center") x -= measured / 2;
    // drawAtPoint uses the baseline, and AppKit's origin is the bottom.
    const y = height - op.y * scale;
    s.drawAtPointWithAttributes($.NSMakePoint(x, y), attrs);
  }

  function drawRound(op) {
    rgba(op.color, op.alpha).setFill;
    const rect = $.NSMakeRect(
      op.x * scale,
      height - (op.y + op.h) * scale,
      Math.max(0.5, op.w * scale),
      Math.max(0.5, op.h * scale),
    );
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(
      rect,
      op.r * scale,
      op.r * scale,
    ).fill;
  }

  for (const op of spec.ops) {
    if (op.op === "text") drawText(op);
    else if (op.op === "round") drawRound(op);
  }

  const data = rep.representationUsingTypeProperties(
    $.NSBitmapImageFileTypePNG,
    $.NSDictionary.dictionary,
  );
  if (!data || !data.writeToFileAtomically(outPath, true)) {
    throw new Error("could not write the board");
  }
  return "ok";
}
