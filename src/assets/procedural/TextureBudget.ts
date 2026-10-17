/**
 * Texture memory budget. iOS Safari kills a tab that exceeds ~1 GB (the page just reloads), so on
 * the mobile tier shipped images are downscaled on load and secondary maps (normal / roughness)
 * are skipped. Desktop keeps full size.
 */
export const textureBudget = { maxSize: 4096, secondaryMaps: true };

export function setTextureBudget(tier: 'mobile' | 'desktop' | 'ultra'): void {
  textureBudget.maxSize = tier === 'mobile' ? 512 : tier === 'desktop' ? 2048 : 4096;
  textureBudget.secondaryMaps = tier !== 'mobile';
}

/** Returns the image itself or a downscaled canvas copy (the full-size decode can then be freed). */
export function fitToBudget<T extends HTMLImageElement | ImageBitmap | HTMLCanvasElement>(img: T, scale = 1): T | HTMLCanvasElement {
  const max = Math.max(64, Math.round(textureBudget.maxSize * scale));
  const w = (img as HTMLImageElement).naturalWidth || img.width, h = (img as HTMLImageElement).naturalHeight || img.height;
  const k = max / Math.max(w, h);
  if (!(k < 1)) return img;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
