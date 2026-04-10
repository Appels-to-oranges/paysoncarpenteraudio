"""
Generate ChromeEQ marketing images from Desktop UI captures.

Prefers Upscayl-upscaled PNGs on the Desktop; falls back to eq1.png–eq3.png.

Visual style matches Chromepressor shots: a blurred, scaled copy of the same
UI fills the frame (no flat gray letterboxing), with the sharp UI composited
on top. RGBA sources keep transparency over the blur.

Outputs:
  public/images/chromeeq/main.png, view-2.png, view-3.png — 676×800 (site hero)
  public/images/chromeeq/webstore/ — Chrome Web Store sizes (RGB PNG)
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageFilter

# Chromepressor marketing gray (letterboxing only used inside flattened blur layer)
BG = (210, 210, 210)

WEB_W, WEB_H = 676, 800
SCREENSHOT_W, SCREENSHOT_H = 1280, 800
SMALL_W, SMALL_H = 440, 280
MARQUEE_W, MARQUEE_H = 1400, 560


def flatten_rgba(im: Image.Image, bg: tuple[int, int, int] = BG) -> Image.Image:
    if im.mode == "RGBA":
        base = Image.new("RGB", im.size, bg)
        base.paste(im, mask=im.split()[3])
        return base
    return im.convert("RGB")


def auto_blur_radius(cw: int, ch: int) -> int:
    return max(14, int(round(min(cw, ch) * 0.032)))


def scale_cover_flatten(
    im: Image.Image,
    tw: int,
    th: int,
    bg: tuple[int, int, int] = BG,
) -> Image.Image:
    """Scale up, crop center to tw×th, opaque RGB."""
    im = flatten_rgba(im, bg)
    w, h = im.size
    scale = max(tw / w, th / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return im.crop((left, top, left + tw, top + th))


def contain_rgba(im: Image.Image, tw: int, th: int) -> Image.Image:
    """Fit inside tw×th, centered on a transparent RGBA canvas."""
    im = im.convert("RGBA")
    w, h = im.size
    scale = min(tw / w, th / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    resized = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    x = (tw - nw) // 2
    y = (th - nh) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def marketing_shot(
    im: Image.Image,
    canvas_w: int,
    canvas_h: int,
    bg: tuple[int, int, int] = BG,
    blur_radius: int | None = None,
) -> Image.Image:
    """Blurred cover background + sharp centered UI. RGB for Web Store / site."""
    if blur_radius is None:
        blur_radius = auto_blur_radius(canvas_w, canvas_h)
    blurred = scale_cover_flatten(im, canvas_w, canvas_h, bg).filter(
        ImageFilter.GaussianBlur(radius=blur_radius)
    )
    sharp = contain_rgba(im, canvas_w, canvas_h)
    out = blurred.convert("RGBA")
    out.paste(sharp, (0, 0), sharp)
    return out.convert("RGB")


def marquee_panels(
    images: list[Image.Image],
    w: int,
    h: int,
    bg: tuple[int, int, int] = BG,
) -> Image.Image:
    n = len(images)
    base = w // n
    remainder = w % n
    panel_widths = [base + (1 if i < remainder else 0) for i in range(n)]
    out = Image.new("RGB", (w, h), bg)
    x = 0
    for im, pw in zip(images, panel_widths):
        cell = marketing_shot(im, pw, h, bg)
        out.paste(cell, (x, 0))
        x += pw
    return out


def resolve_sources(desktop: Path) -> list[Path]:
    upscaled = [
        desktop / "eq1_upscayl_2x_high-fidelity-4x.png",
        desktop / "eq2_upscayl_2x_high-fidelity-4x.png",
        desktop / "eq3_upscayl_2x_high-fidelity-4x.png",
    ]
    plain = [desktop / "eq1.png", desktop / "eq2.png", desktop / "eq3.png"]
    if all(p.exists() for p in upscaled):
        return upscaled
    if all(p.exists() for p in plain):
        print("Using eq1.png–eq3.png (upscaled PNGs not found on Desktop).", file=sys.stderr)
        return plain
    missing = [str(p) for p in upscaled + plain if not p.exists()]
    print("Missing Desktop sources. Expected either Upscayl trio or eq1–eq3.png.", file=sys.stderr)
    print("Checked:", *missing[:6], sep="\n  ", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    desktop = Path.home() / "Desktop"
    sources = resolve_sources(desktop)
    loaded = [Image.open(p) for p in sources]

    repo_root = Path(__file__).resolve().parent.parent
    chromeeq_dir = repo_root / "public" / "images" / "chromeeq"
    webstore_dir = chromeeq_dir / "webstore"
    webstore_dir.mkdir(parents=True, exist_ok=True)

    site_names = ["main.png", "view-2.png", "view-3.png"]
    for im, name in zip(loaded, site_names):
        shot = marketing_shot(im, WEB_W, WEB_H, BG)
        dest = chromeeq_dir / name
        shot.save(dest, "PNG", optimize=True)
        print(f"Wrote {dest}")

    for i, im in enumerate(loaded, start=1):
        shot = marketing_shot(im, SCREENSHOT_W, SCREENSHOT_H, BG)
        dest = webstore_dir / f"screenshot-{i}-1280x800.png"
        shot.save(dest, "PNG", optimize=True)
        assert shot.size == (SCREENSHOT_W, SCREENSHOT_H)
        print(f"Wrote {dest}")

    small = marketing_shot(loaded[0], SMALL_W, SMALL_H, BG)
    small_path = webstore_dir / "promo-small-440x280.png"
    small.save(small_path, "PNG", optimize=True)
    print(f"Wrote {small_path}")

    marquee = marquee_panels(loaded, MARQUEE_W, MARQUEE_H, BG)
    mq_path = webstore_dir / "promo-marquee-1400x560.png"
    marquee.save(mq_path, "PNG", optimize=True)
    print(f"Wrote {mq_path}")

    print("\nDone. Site: chromeeq/main.png + view-2/3. Web Store assets in chromeeq/webstore/.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
