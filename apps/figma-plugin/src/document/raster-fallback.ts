import type { SourceNode } from './extraction.ts';

type Bounds = { x: number; y: number; width: number; height: number };
type RasterPlan = { bounds?: Bounds; useAbsoluteBounds: boolean; reason: string };

// Exporting full node bounds keeps a polygon's transparent margins and its layout
// slot. Cropped render bounds are reserved for overflow under a non-stack parent.
export function rasterFallbackPlan(node: SourceNode, parentId: string | null, parent: SourceNode | undefined,
  interactiveAncestor: boolean, rotatedAncestor: boolean): RasterPlan {
  const blocked = (reason: string): RasterPlan => ({ useAbsoluteBounds: false, reason });
  if (!['RECTANGLE', 'POLYGON'].includes(node.type) || parentId === null || node.children?.length)
    return blocked('PNG fallback is limited to decorative polygon/rectangle leaves, not screens or subtrees.');
  if (interactiveAncestor || node.reactions?.length)
    return blocked('Interactive ancestry or reactions prevent decorative PNG approval.');
  if (rotatedAncestor || node.rotation)
    return blocked('This layer or an ancestor is rotated; raster positioning is not verified.');
  if (node.isMask) return blocked('Masks cannot use decorative PNG approval.');
  if (!parent || !['NONE', 'HORIZONTAL', 'VERTICAL'].includes(parent.layoutMode ?? 'NONE'))
    return blocked('The parent layout is unsupported for decorative PNG positioning.');
  const box = node.absoluteBoundingBox, render = node.absoluteRenderBounds, parentBox = parent.absoluteBoundingBox;
  const finite = (bounds: Bounds | null | undefined): bounds is Bounds => !!bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
  if (!finite(box) || !finite(parentBox)) return blocked('Layer or parent bounding-box geometry is unavailable.');
  if (!finite(render)) return blocked('Visible render bounds are unavailable or empty.');
  const tolerance = 1e-6;
  if (Math.abs(box.x - node.x - parentBox.x) > tolerance || Math.abs(box.y - node.y - parentBox.y) > tolerance ||
      Math.abs(box.width - node.width) > tolerance || Math.abs(box.height - node.height) > tolerance)
    return blocked('Layer and parent coordinates do not match the unrotated bounding box.');
  const pixelBounds = (bounds: Bounds) => Number.isInteger(bounds.width) && Number.isInteger(bounds.height) &&
    bounds.width <= 4096 && bounds.height <= 4096 && bounds.width * bounds.height <= 4194304;
  const inside = render.x >= box.x - tolerance && render.y >= box.y - tolerance &&
    render.x + render.width <= box.x + box.width + tolerance && render.y + render.height <= box.y + box.height + tolerance;
  if (inside && pixelBounds(box)) return { bounds: box, useAbsoluteBounds: true, reason: '' };
  if ((parent.layoutMode ?? 'NONE') !== 'NONE')
    return blocked('Pixels extend outside the layer slot or its dimensions are not whole pixels; auto-layout spacing cannot be preserved.');
  if (!pixelBounds(render))
    return blocked(`Raster dimensions ${render.width} × ${render.height} are fractional or exceed the pixel budget; full layer bounds are also unavailable for this export.`);
  return { bounds: render, useAbsoluteBounds: false, reason: '' };
}
