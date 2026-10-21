# dmgbuild -s settings.py -D app=<Timeline.app> -D background=<background.png> Timeline <out.dmg>
files = [defines["app"]]  # noqa: F821
symlinks = {"Applications": "/Applications"}
format = "UDZO"

# Layout must match render-background.ts. dmgbuild also picks up the @2x image.
background = defines["background"]  # noqa: F821
window_rect = ((200, 120), (640, 400))
icon_size = 96
text_size = 13
icon_locations = {
    "Timeline.app": (160, 170),
    "Applications": (480, 170),
}
