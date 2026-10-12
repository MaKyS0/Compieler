"""turtle for the Compieler app (no Tk needed).

Drawing commands are recorded while your program runs; when it ends (or at done() / mainloop()) the
picture is sent to the Graphics tab as an animated SVG that replays the drawing.
Supported: movement, turning, pen and fill, colors, circle/dot/stamp/write, shapes, several turtles,
speed(), tracer(), world coordinates.  Keyboard / mouse events are accepted but never fire.
"""
import math as _math
import sys as _sys

__all__ = []  # filled in at the bottom

_MAX_ELEMENTS = 200_000
_MAX_SECONDS = 60.0
_MAX_KEYFRAMES = 40_000
_COLOR_NOTE = False


class TurtleGraphicsError(Exception):
    pass


class Terminator(Exception):
    pass


class Vec2D(tuple):
    def __new__(cls, x, y):
        return tuple.__new__(cls, (x, y))

    def __add__(self, o):
        return Vec2D(self[0] + o[0], self[1] + o[1])

    def __mul__(self, o):
        if isinstance(o, tuple):
            return self[0] * o[0] + self[1] * o[1]
        return Vec2D(self[0] * o, self[1] * o)

    def __rmul__(self, o):
        if isinstance(o, (int, float)):
            return Vec2D(self[0] * o, self[1] * o)
        return NotImplemented

    def __sub__(self, o):
        return Vec2D(self[0] - o[0], self[1] - o[1])

    def __neg__(self):
        return Vec2D(-self[0], -self[1])

    def __abs__(self):
        return (self[0] ** 2 + self[1] ** 2) ** 0.5

    def rotate(self, angle):
        a = _math.radians(angle)
        c, s = _math.cos(a), _math.sin(a)
        return Vec2D(self[0] * c - self[1] * s, self[0] * s + self[1] * c)

    def __repr__(self):
        return "(%.2f,%.2f)" % self


# ----------------------------------------------------------------------------- colors
def _css(spec, cmode):
    if isinstance(spec, str):
        s = spec.strip()
        if s.startswith("#"):
            return s
        s = s.lower().replace(" ", "")
        if s.startswith(("gray", "grey")) and s[4:].isdigit():
            v = round(int(s[4:]) * 255 / 100)
            return "#%02x%02x%02x" % (v, v, v)
        return s
    if isinstance(spec, (tuple, list)) and len(spec) == 3:
        vals = []
        for v in spec:
            v = v * 255 if cmode == 1.0 else v
            vals.append(max(0, min(255, int(round(v)))))
        return "#%02x%02x%02x" % tuple(vals)
    raise TurtleGraphicsError("bad color arguments: %r" % (spec,))


def _esc(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ----------------------------------------------------------------------------- shapes (pointing east)
def _up_to_east(points):
    return [(py, -px) for px, py in points]


_SHAPES = {
    "classic": [(10, 0), (-8, -6), (-4, 0), (-8, 6)],
    "arrow": [(10, 0), (-10, -8), (-10, 8)],
    "triangle": [(10, 0), (-5, 8.66), (-5, -8.66)],
    "square": [(10, 10), (10, -10), (-10, -10), (-10, 10)],
    "turtle": _up_to_east([(0, 16), (-2, 14), (-1, 10), (-4, 7), (-7, 9), (-9, 8), (-6, 5), (-7, 1), (-5, -3), (-8, -6),
                           (-6, -8), (-4, -5), (0, -7), (4, -5), (6, -8), (8, -6), (5, -3), (7, 1), (6, 5), (9, 8),
                           (7, 9), (4, 7), (1, 10), (2, 14)]),
}


# ----------------------------------------------------------------------------- scene shared by all turtles
class _Scene:
    def __init__(self):
        self.reset()

    def reset(self):
        self.width, self.height = 800, 600
        self.world = None  # (llx, lly, urx, ury)
        self.bg = "white"
        self.title = "Turtle"
        self.cmode = 1.0
        self.tracer_n = 1
        self.elements = []
        self.t = 0.0
        self.turtles = []
        self.version = 0
        self.flushed = -1
        self.mode = "standard"
        self.fullcircle = 360.0
        self.events_note = False

    def add(self, el):
        if len(self.elements) >= _MAX_ELEMENTS:
            raise Terminator("too many drawing operations for the offline turtle (limit %d)" % _MAX_ELEMENTS)
        self.elements.append(el)
        self.version += 1
        return el


_scene = _Scene()


def _note_events(name):
    if not _scene.events_note:
        _scene.events_note = True
        print("turtle: %s is accepted but keyboard / mouse events are not supported in this app (drawing only)." % name,
              file=_sys.stderr)


# ----------------------------------------------------------------------------- Turtle
class Turtle:
    _default_shape = "classic"

    def __init__(self, shape="classic", undobuffersize=1000, visible=True):
        s = _scene
        self._x, self._y = 0.0, 0.0
        self._h = 0.0  # cumulative heading in degrees, counter-clockwise from east
        self._down = True
        self._pen = ("black", "black")
        self._fill = ("black", "black")
        self._size = 1.0
        self._visible = visible
        self._speed = 3
        self._shape = shape if shape in _SHAPES else "classic"
        self._stretch = (1.0, 1.0)
        self._filling = False
        self._fill_points = []
        self._fill_slot = None
        self._fill_t = 0.0
        self._track = []  # cursor keyframes (t, x, y, heading)
        self._vis_track = [(0.0, visible)]
        self._mine = []
        s.turtles.append(self)
        self._key(0.0)

    # --- internals
    def _key(self, t):
        self._track.append((t, self._x, self._y, self._h))

    def _animated_speed(self):
        if _scene.tracer_n == 0:
            return 0
        return self._speed

    def _move_time(self, dist):
        sp = self._animated_speed()
        return 0.0 if sp == 0 else dist / (80.0 * sp)

    def _turn_time(self, deg):
        sp = self._animated_speed()
        return 0.0 if sp == 0 else abs(deg) / (180.0 * sp)

    def _add(self, el):
        el["owner"] = self
        el["cleared"] = None
        _scene.add(el)
        self._mine.append(el)
        return el

    def _deg(self, angle):
        return angle * 360.0 / _scene.fullcircle

    def _rot(self, deg):
        s = _scene
        if deg == 0:
            return
        self._key(s.t)
        s.t += self._turn_time(deg)
        self._h += deg
        self._key(s.t)
        s.version += 1

    def _go(self, nx, ny):
        s = _scene
        dist = _math.hypot(nx - self._x, ny - self._y)
        if dist == 0:
            return
        self._key(s.t)
        t0 = s.t
        dur = self._move_time(dist)
        s.t += dur
        if self._down:
            self._add({"k": "line", "x1": self._x, "y1": self._y, "x2": nx, "y2": ny, "c": self._pen[0],
                       "w": self._size, "t0": t0, "dur": dur})
        self._x, self._y = nx, ny
        if self._filling:
            self._fill_points.append((nx, ny))
        self._key(s.t)

    # --- movement
    def forward(self, distance):
        a = _math.radians(self._h)
        self._go(self._x + distance * _math.cos(a), self._y + distance * _math.sin(a))

    def backward(self, distance):
        self.forward(-distance)

    def left(self, angle):
        self._rot(self._deg(angle))

    def right(self, angle):
        self._rot(-self._deg(angle))

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        self._go(float(x), float(y))

    def setx(self, x):
        self._go(float(x), self._y)

    def sety(self, y):
        self._go(self._x, float(y))

    def setheading(self, to_angle):
        to = self._deg(to_angle)
        if _scene.mode == "logo":
            to = 90 - to
        d = (to - self._h) % 360.0
        if d > 180:
            d -= 360
        self._rot(d)

    def home(self):
        self.goto(0, 0)
        self.setheading(0)

    def circle(self, radius, extent=None, steps=None):
        ext = 360.0 if extent is None else self._deg(extent)
        frac = abs(ext) / 360.0
        if steps is None:
            steps = 1 + int(min(11 + abs(radius) / 6.0, 59.0) * frac)
        w = ext / steps
        w2 = 0.5 * w
        length = 2.0 * radius * _math.sin(_math.radians(w2))
        if radius < 0:
            length, w, w2 = -length, -w, -w2
        self._rot(w2)
        for _ in range(steps):
            self.forward(length)
            self._rot(w)
        self._rot(-w2)

    def dot(self, size=None, *color):
        if size is None:
            size = max(self._size + 4, 2 * self._size)
        c = _css(color[0] if len(color) == 1 else color, _scene.cmode) if color else self._pen[0]
        self._add({"k": "dot", "x": self._x, "y": self._y, "r": size / 2.0, "c": c, "t0": _scene.t})

    def stamp(self):
        self._add({"k": "stamp", "x": self._x, "y": self._y, "h": self._h, "t0": _scene.t, "shape": self._shape,
                   "stretch": self._stretch, "pen": self._pen[0], "fill": self._fill[0], "w": self._size})
        return len(self._mine)

    def clearstamp(self, stampid=None):
        pass

    def clearstamps(self, n=None):
        for el in self._mine:
            if el["k"] == "stamp" and el["cleared"] is None:
                el["cleared"] = _scene.t
        _scene.version += 1

    def write(self, arg, move=False, align="left", font=("Arial", 8, "normal")):
        name, size, style = (tuple(font) + ("Arial", 8, "normal")[len(font):])[:3] if font else ("Arial", 8, "normal")
        self._add({"k": "text", "x": self._x, "y": self._y, "text": str(arg), "align": align, "font": name,
                   "size": size, "style": style, "c": self._pen[0], "t0": _scene.t})
        if move:
            self._go(self._x + len(str(arg)) * size * 0.75, self._y)

    # --- state
    def pos(self):
        return Vec2D(self._x, self._y)

    position = pos

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def heading(self):
        h = self._h % 360.0
        if _scene.mode == "logo":
            h = (90 - h) % 360.0
        return h * _scene.fullcircle / 360.0

    def distance(self, x, y=None):
        if y is None:
            x, y = x if isinstance(x, (tuple, list)) else (x.xcor(), x.ycor())
        return _math.hypot(x - self._x, y - self._y)

    def towards(self, x, y=None):
        if y is None:
            x, y = x if isinstance(x, (tuple, list)) else (x.xcor(), x.ycor())
        ang = _math.degrees(_math.atan2(y - self._y, x - self._x)) % 360.0
        if _scene.mode == "logo":
            ang = (90 - ang) % 360.0
        return ang * _scene.fullcircle / 360.0

    def degrees(self, fullcircle=360.0):
        _scene.fullcircle = float(fullcircle)

    def radians(self):
        _scene.fullcircle = 2 * _math.pi

    # --- pen
    def penup(self):
        self._down = False

    def pendown(self):
        self._down = True

    def isdown(self):
        return self._down

    def pensize(self, width=None):
        if width is None:
            return self._size
        self._size = float(width)

    width = pensize

    def speed(self, speed=None):
        names = {"fastest": 0, "fast": 10, "normal": 6, "slow": 3, "slowest": 1}
        if speed is None:
            return self._speed
        if isinstance(speed, str):
            speed = names.get(speed, 6)
        speed = int(round(speed))
        self._speed = 0 if speed > 10 or speed < 0.5 else speed

    def pencolor(self, *args):
        if not args:
            return self._pen[1]
        spec = args[0] if len(args) == 1 else args
        self._pen = (_css(spec, _scene.cmode), spec)
        _scene.version += 1

    def fillcolor(self, *args):
        if not args:
            return self._fill[1]
        spec = args[0] if len(args) == 1 else args
        self._fill = (_css(spec, _scene.cmode), spec)
        _scene.version += 1

    def color(self, *args):
        if not args:
            return self._pen[1], self._fill[1]
        if len(args) == 1:
            self.pencolor(args[0])
            self.fillcolor(args[0])
        elif len(args) == 2:
            self.pencolor(args[0])
            self.fillcolor(args[1])
        else:
            self.pencolor(args)
            self.fillcolor(args)

    def begin_fill(self):
        if self._filling:
            return
        self._filling = True
        self._fill_points = [(self._x, self._y)]
        self._fill_slot = self._add({"k": "fill", "pts": None, "c": None, "t0": _scene.t})

    def end_fill(self):
        if not self._filling:
            return
        self._filling = False
        slot = self._fill_slot
        if len(self._fill_points) >= 3:
            slot["pts"] = list(self._fill_points)
            slot["c"] = self._fill[0]
            slot["t0"] = _scene.t
        self._fill_slot = None
        _scene.version += 1

    def filling(self):
        return self._filling

    def reset(self):
        self.clear()
        self._x = self._y = 0.0
        self._h = 0.0
        self._key(_scene.t)

    def clear(self):
        for el in self._mine:
            if el["cleared"] is None:
                el["cleared"] = _scene.t
        _scene.version += 1

    # --- appearance
    def showturtle(self):
        self._visible = True
        self._vis_track.append((_scene.t, True))

    def hideturtle(self):
        self._visible = False
        self._vis_track.append((_scene.t, False))

    def isvisible(self):
        return self._visible

    def shape(self, name=None):
        if name is None:
            return self._shape
        self._shape = name if (name in _SHAPES or name == "circle") else "classic"

    def shapesize(self, stretch_wid=None, stretch_len=None, outline=None):
        if stretch_wid is None and stretch_len is None:
            return self._stretch + (self._size,)
        w = stretch_wid if stretch_wid is not None else self._stretch[0]
        length = stretch_len if stretch_len is not None else w
        self._stretch = (float(w), float(length))
        if outline is not None:
            self._size = float(outline)

    turtlesize = shapesize

    def getscreen(self):
        return Screen()

    def clone(self):
        t = Turtle()
        t._x, t._y, t._h = self._x, self._y, self._h
        t._down, t._pen, t._fill, t._size = self._down, self._pen, self._fill, self._size
        t._visible, t._speed, t._shape, t._stretch = self._visible, self._speed, self._shape, self._stretch
        t._key(_scene.t)
        return t

    def undo(self):
        pass

    def setundobuffer(self, size):
        pass

    def undobufferentries(self):
        return 0

    def tilt(self, angle):
        pass

    def settiltangle(self, angle):
        pass

    # --- events (accepted, never fired)
    def onclick(self, fun, btn=1, add=None):
        _note_events("onclick")

    def onrelease(self, fun, btn=1, add=None):
        _note_events("onrelease")

    def ondrag(self, fun, btn=1, add=None):
        _note_events("ondrag")

    # --- aliases
    fd = forward
    bk = back = backward
    lt = left
    rt = right
    setpos = setposition = goto
    seth = setheading
    pu = up = penup
    pd = down = pendown
    st = showturtle
    ht = hideturtle


RawTurtle = RawPen = Pen = Turtle


# ----------------------------------------------------------------------------- Screen
class _Screen:
    def bgcolor(self, *args):
        if not args:
            return _scene.bg
        _scene.bg = _css(args[0] if len(args) == 1 else args, _scene.cmode)
        _scene.version += 1

    def title(self, titlestring):
        _scene.title = str(titlestring)

    def setup(self, width=0.5, height=0.75, startx=None, starty=None):
        scr_w, scr_h = 1000, 800
        _scene.width = int(width * scr_w) if isinstance(width, float) and width <= 1 else int(width)
        _scene.height = int(height * scr_h) if isinstance(height, float) and height <= 1 else int(height)
        _scene.version += 1

    def screensize(self, canvwidth=None, canvheight=None, bg=None):
        if canvwidth is None and canvheight is None:
            return _scene.width, _scene.height
        if canvwidth:
            _scene.width = int(canvwidth)
        if canvheight:
            _scene.height = int(canvheight)
        if bg:
            self.bgcolor(bg)

    def window_width(self):
        return _scene.width

    def window_height(self):
        return _scene.height

    def setworldcoordinates(self, llx, lly, urx, ury):
        _scene.world = (llx, lly, urx, ury)
        _scene.version += 1

    def colormode(self, cmode=None):
        if cmode is None:
            return _scene.cmode
        _scene.cmode = 1.0 if float(cmode) == 1.0 else 255

    def mode(self, mode=None):
        if mode is None:
            return _scene.mode
        _scene.mode = mode

    def tracer(self, n=None, delay=None):
        if n is None:
            return _scene.tracer_n
        _scene.tracer_n = int(n)

    def delay(self, delay=None):
        return 10 if delay is None else None

    def update(self):
        _scene.version += 1

    def turtles(self):
        return list(_scene.turtles)

    def clear(self):
        for t in _scene.turtles:
            t.clear()

    clearscreen = clear

    def reset(self):
        for t in _scene.turtles:
            t.reset()

    resetscreen = reset

    def bgpic(self, picname=None):
        return "nopic"

    def register_shape(self, name, shape=None):
        pass

    addshape = register_shape

    def getshapes(self):
        return sorted(_SHAPES) + ["circle"]

    def textinput(self, title, prompt):
        try:
            return input(str(prompt) + " ")
        except EOFError:
            return None

    def numinput(self, title, prompt, default=None, minval=None, maxval=None):
        try:
            return float(input(str(prompt) + " "))
        except (EOFError, ValueError):
            return default

    def mainloop(self):
        _flush(force=True)

    done = mainloop

    def exitonclick(self):
        _flush(force=True)

    def bye(self):
        _flush(force=True)

    def listen(self, xdummy=None, ydummy=None):
        pass

    def getcanvas(self):
        return None

    def _ev(name):
        def f(self, *a, **k):
            _note_events(name)
        return f

    onkey = _ev("onkey")
    onkeypress = _ev("onkeypress")
    onkeyrelease = _ev("onkeyrelease")
    onclick = onscreenclick = _ev("onscreenclick")
    ontimer = _ev("ontimer")
    del _ev


_the_screen = None


def Screen():
    global _the_screen
    if _the_screen is None:
        _the_screen = _Screen()
    return _the_screen


_default_turtle = None


def _turtle():
    global _default_turtle
    if _default_turtle is None:
        _default_turtle = Turtle()
    return _default_turtle


# ----------------------------------------------------------------------------- SVG
def _t(v):
    return "%.3f" % v


def _fmt(v):
    r = ("%.2f" % v).rstrip("0").rstrip(".")
    return "0" if r in ("", "-0") else r


def _poly_svg(shape, x, y, h, stretch, stroke, fill, width):
    pts = _SHAPES.get(shape)
    sw, sl = stretch
    if shape == "circle":
        return '<circle cx="0" cy="0" r="%s" fill="%s" stroke="%s" stroke-width="%s"/>' % (_fmt(10 * sw), fill, stroke, _fmt(max(1, width)))
    s = " ".join("%s,%s" % (_fmt(px * sl), _fmt(-py * sw)) for px, py in pts)
    return '<polygon points="%s" fill="%s" stroke="%s" stroke-width="%s" stroke-linejoin="round"/>' % (s, fill, stroke, _fmt(max(1, width)))


def _build_svg():
    s = _scene
    k = 1.0
    if s.t > _MAX_SECONDS:
        k = _MAX_SECONDS / s.t
    T = s.t * k
    if s.world:
        llx, lly, urx, ury = s.world
        vx, vy, vw, vh = llx, -ury, urx - llx, ury - lly
    else:
        vx, vy, vw, vh = -s.width / 2.0, -s.height / 2.0, s.width, s.height
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="%s %s %s %s">' % (s.width, s.height, _fmt(vx), _fmt(vy), _fmt(vw), _fmt(vh)),
           '<rect x="%s" y="%s" width="%s" height="%s" fill="%s"/>' % (_fmt(vx), _fmt(vy), _fmt(vw), _fmt(vh), s.bg)]

    def timing(el, hidden_until):
        """(extra attributes, child nodes) that make an element appear at hidden_until and vanish when cleared."""
        attrs, kids = "", ""
        t0 = hidden_until * k
        if t0 > 0.0005:
            attrs = ' visibility="hidden"'
            kids += '<set attributeName="visibility" to="visible" begin="%ss" fill="freeze"/>' % _t(t0)
        if el["cleared"] is not None:
            kids += '<set attributeName="visibility" to="hidden" begin="%ss" fill="freeze"/>' % _t(el["cleared"] * k)
        return attrs, kids

    for el in s.elements:
        kind = el["k"]
        if kind == "line":
            dx, dy = el["x2"] - el["x1"], el["y2"] - el["y1"]
            length = _math.hypot(dx, dy)
            base = '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="%s" stroke-linecap="round"' % (
                _fmt(el["x1"]), _fmt(-el["y1"]), _fmt(el["x2"]), _fmt(-el["y2"]), el["c"], _fmt(el["w"]))
            dur = el["dur"] * k
            if dur > 0.002:
                kids = '<animate attributeName="stroke-dashoffset" from="%s" to="0" begin="%ss" dur="%ss" fill="freeze"/>' % (_fmt(length), _t(el["t0"] * k), _t(dur))
                _, extra = timing(el, 0)
                out.append('%s stroke-dasharray="%s" stroke-dashoffset="%s">%s%s</line>' % (base, _fmt(length), _fmt(length), kids, extra))
            else:
                attrs, kids = timing(el, el["t0"])
                out.append("%s%s>%s</line>" % (base, attrs, kids))
        elif kind == "fill":
            if not el["pts"]:
                continue
            attrs, kids = timing(el, el["t0"])
            pts = " ".join("%s,%s" % (_fmt(x), _fmt(-y)) for x, y in el["pts"])
            out.append('<polygon points="%s" fill="%s" stroke="none"%s>%s</polygon>' % (pts, el["c"], attrs, kids))
        elif kind == "dot":
            attrs, kids = timing(el, el["t0"])
            out.append('<circle cx="%s" cy="%s" r="%s" fill="%s"%s>%s</circle>' % (_fmt(el["x"]), _fmt(-el["y"]), _fmt(el["r"]), el["c"], attrs, kids))
        elif kind == "text":
            attrs, kids = timing(el, el["t0"])
            anchor = {"left": "start", "center": "middle", "right": "end"}.get(el["align"], "start")
            style = str(el["style"])
            weight = ' font-weight="bold"' if "bold" in style else ""
            italic = ' font-style="italic"' if "italic" in style else ""
            out.append('<text x="%s" y="%s" fill="%s" font-family="%s, sans-serif" font-size="%s" text-anchor="%s"%s%s%s>%s%s</text>' % (
                _fmt(el["x"]), _fmt(-el["y"]), el["c"], _esc(el["font"]), _fmt(el["size"] * 1.33), anchor, weight, italic, attrs, _esc(el["text"]), kids))
        elif kind == "stamp":
            attrs, kids = timing(el, el["t0"])
            shape = _poly_svg(el["shape"], 0, 0, 0, el["stretch"], el["pen"], el["fill"], el["w"])
            out.append('<g transform="translate(%s %s) rotate(%s)"%s>%s%s</g>' % (_fmt(el["x"]), _fmt(-el["y"]), _fmt(-el["h"]), attrs, shape, kids))

    # turtle cursors
    keyframes = sum(len(t._track) for t in s.turtles)
    for t in s.turtles:
        vis_changes = len(t._vis_track) > 1
        if not t._visible and not vis_changes:
            continue
        shape = _poly_svg(t._shape, 0, 0, 0, t._stretch, t._pen[0], t._fill[0], t._size)
        last = t._track[-1]
        if T <= 0.001 or keyframes > _MAX_KEYFRAMES:
            vis = "" if t._visible else ' visibility="hidden"'
            out.append('<g transform="translate(%s %s) rotate(%s)"%s>%s</g>' % (_fmt(last[1]), _fmt(-last[2]), _fmt(-last[3]), vis, shape))
            continue
        kt, tr, rot = [], [], []
        for (ti, x, y, h) in t._track:
            kt.append(_fmt_k(min(1.0, ti * k / T)))
            tr.append("%s %s" % (_fmt(x), _fmt(-y)))
            rot.append("%s" % _fmt(-h))
        kt[0] = "0"
        kt[-1] = "1" if kt[-1] != "1" else kt[-1]
        opacity = ""
        if vis_changes:
            vt, vv = [], []
            for (ti, v) in t._vis_track:
                vt.append(_fmt_k(min(1.0, ti * k / T)))
                vv.append("1" if v else "0")
            vt[0] = "0"
            opacity = '<animate attributeName="opacity" calcMode="discrete" values="%s" keyTimes="%s" dur="%ss" fill="freeze"/>' % (";".join(vv), ";".join(vt), _t(T))
        out.append('<g>%s<animateTransform attributeName="transform" type="translate" calcMode="linear" values="%s" keyTimes="%s" dur="%ss" fill="freeze"/>'
                   '<g><animateTransform attributeName="transform" type="rotate" calcMode="linear" values="%s" keyTimes="%s" dur="%ss" fill="freeze"/>%s</g></g>' % (
                       opacity, ";".join(tr), ";".join(kt), _t(T), ";".join(rot), ";".join(kt), _t(T), shape))
    out.append("</svg>")
    return "".join(out)


def _fmt_k(v):
    return ("%.5f" % v).rstrip("0").rstrip(".") or "0"


def _flush(force=False):
    s = _scene
    if not s.turtles or (s.version == s.flushed and not force):
        return
    if not s.elements and not any(t._visible for t in s.turtles) and not force:
        return
    s.flushed = s.version
    svg = _build_svg()
    try:
        import js
        send = getattr(js, "__compieler_gfx", None)
    except ImportError:
        send = None
    if send is not None:
        send("turtle", svg)
    else:
        with open("turtle.svg", "w", encoding="utf-8") as f:
            f.write(svg)


def _compieler_end_of_program():
    """Called by the app when the program finishes."""
    try:
        _flush()
    except Exception as e:  # never break the program's exit status because of the picture
        print("turtle: could not render the drawing:", e, file=_sys.stderr)


# ----------------------------------------------------------------------------- module-level functions
def _make(obj_getter, name):
    def f(*args, **kw):
        return getattr(obj_getter(), name)(*args, **kw)
    f.__name__ = name
    f.__doc__ = getattr(Turtle if obj_getter is _turtle else _Screen, name, None).__doc__
    return f


_turtle_methods = [
    "forward", "fd", "backward", "bk", "back", "left", "lt", "right", "rt", "goto", "setpos", "setposition", "setx", "sety",
    "setheading", "seth", "home", "circle", "dot", "stamp", "clearstamp", "clearstamps", "write", "pos", "position", "xcor",
    "ycor", "heading", "distance", "towards", "penup", "pu", "up", "pendown", "pd", "down", "isdown", "pensize", "width",
    "speed", "pencolor", "fillcolor", "color", "begin_fill", "end_fill", "filling", "showturtle", "st", "hideturtle", "ht",
    "isvisible", "shape", "shapesize", "turtlesize", "clone", "undo", "setundobuffer", "undobufferentries", "tilt",
    "settiltangle", "onclick", "onrelease", "ondrag", "getscreen",
]
_screen_methods = [
    "bgcolor", "title", "setup", "screensize", "window_width", "window_height", "setworldcoordinates", "colormode",
    "mode", "tracer", "delay", "update", "turtles", "clearscreen", "resetscreen", "bgpic", "register_shape", "addshape",
    "getshapes", "textinput", "numinput", "mainloop", "done", "exitonclick", "bye", "listen", "getcanvas", "onkey",
    "onkeypress", "onkeyrelease", "onscreenclick", "ontimer",
]
for _n in _turtle_methods:
    globals()[_n] = _make(_turtle, _n)
for _n in _screen_methods:
    globals()[_n] = _make(Screen, _n)


def degrees(fullcircle=360.0):
    _turtle().degrees(fullcircle)


def radians():
    _turtle().radians()


def reset():
    _turtle().reset()
    Screen().reset()


def clear():
    _turtle().clear()


__all__ = sorted(
    ["Turtle", "RawTurtle", "RawPen", "Pen", "Screen", "Vec2D", "TurtleGraphicsError", "Terminator", "degrees", "radians", "reset", "clear"]
    + _turtle_methods + _screen_methods
)
