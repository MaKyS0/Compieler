import random
import turtle

W, H = 820, 540
HOLE_X = -330          # центр чёрной дыры
SAFE_X = 330           # линия безопасности

screen = turtle.Screen()
screen.setup(W, H)
screen.title("Побег от чёрной дыры")
screen.bgcolor("#05060f")
screen.tracer(0)       # рисуем кадр целиком и показываем командой update()

pen = turtle.Turtle()
pen.hideturtle()
pen.speed(0)
pen.penup()


def text(x, y, s, color="white", size=13, bold=False, align="left"):
    pen.goto(x, y)
    pen.color(color)
    pen.write(s, align=align, font=("Arial", size, "bold" if bold else "normal"))


def rect(x, y, w, h, fill=None, outline="white"):
    pen.goto(x, y)
    pen.color(outline, fill or outline)
    pen.pendown()
    if fill:
        pen.begin_fill()
    for dx, dy in ((w, 0), (0, h), (-w, 0), (0, -h)):
        pen.goto(pen.xcor() + dx, pen.ycor() + dy)
    if fill:
        pen.end_fill()
    pen.penup()


def meter(x, y, label, value, color):
    text(x, y + 20, f"{label}: {max(0, value)}", "white", 12)
    rect(x, y, 200, 14, None, "#8890b0")
    if value > 0:
        rect(x, y, 2 * min(100, value), 14, color, color)


def ship(x, y, flame):
    if flame:
        pen.goto(x - 22, y)
        pen.dot(18, "#ffb347")
        pen.goto(x - 30, y)
        pen.dot(10, "#fff3b0")
    pen.goto(x - 16, y - 12)
    pen.color("#cfd8ff", "#7f8fd6")
    pen.pendown()
    pen.begin_fill()
    for px, py in ((x + 20, y), (x - 16, y + 12), (x - 8, y), (x - 16, y - 12)):
        pen.goto(px, py)
    pen.end_fill()
    pen.penup()


def draw(state, log, menu, flame=False):
    pen.clear()
    for sx, sy, size in state["stars"]:
        pen.goto(sx, sy)
        pen.dot(size, "#9aa3c7")
    # чёрная дыра: диск и горизонт событий
    for radius, color in ((165, "#2a1640"), (135, "#6b2a3a"), (105, "#c2561e"), (82, "#ffb347"), (62, "#000000")):
        pen.goto(HOLE_X, 0)
        pen.dot(radius * 2, color)
    # линия безопасности
    pen.goto(SAFE_X, -150)
    pen.color("#3ddc84")
    pen.pendown()
    pen.goto(SAFE_X, 150)
    pen.penup()
    text(SAFE_X - 6, 158, "БЕЗОПАСНО", "#3ddc84", 11, True, "right")
    # корабль: дистанция 0..100 -> от горизонта до линии безопасности
    x = HOLE_X + 85 + max(0, min(100, state["dist"])) * (SAFE_X - 40 - HOLE_X - 85) / 100
    ship(x, 0, flame)
    # индикаторы
    meter(-390, 210, "Топливо", state["fuel"], "#ffb347")
    meter(-160, 210, "Корпус", state["hull"], "#4cc9f0")
    text(80, 205, f"Дистанция: {state['dist']}/100", "white", 13, True)
    text(80, 228, f"Ход {state['turn']}   Груз: {state['cargo']} ящ.", "#9aa3c7", 12)
    # сообщения и меню
    for i, line in enumerate(log[-3:]):
        text(-130, -105 - i * 20, line, "#ffd166", 12)
    for i, line in enumerate(menu):
        text(-130, -185 - i * 20, line, "white", 12)
    screen.update()


MENU = ["1 - Форсаж (+16, -22 топлива)", "2 - Экономный ход (+8, -8 топлива)",
        "3 - Ремонт (+25 корпуса, -8 топлива)", "4 - Сбросить груз (+10)"]


def ask(options):
    while True:
        try:
            answer = input("Выбор (" + "/".join(options) + "): ").strip()
        except EOFError:
            return None
        if answer in options:
            return answer
        print("  Введи один из пунктов:", ", ".join(options))


def event(state):
    roll = random.random()
    if roll < 0.30:
        dmg = random.randint(6, 14)
        state["hull"] -= dmg
        return f"Поле астероидов! Корпус -{dmg}"
    if roll < 0.50:
        gain = random.randint(12, 22)
        state["fuel"] = min(100, state["fuel"] + gain)
        return f"Контейнер с топливом: +{gain}"
    if roll < 0.58:
        state["dist"] -= 5
        return "Гравитационная волна! Дистанция -5"
    if roll < 0.68:
        state["cargo"] += 1
        return "Подобрал ящик с запчастями (+1 груз)"
    return "Космос молчит..."


def play():
    random.seed()
    state = {"turn": 1, "dist": 40, "fuel": 100, "hull": 100, "cargo": 3,
             "stars": [(random.randint(-400, 400), random.randint(-260, 260), random.choice((2, 2, 3, 4))) for _ in range(70)]}
    log = ["Гравитация ловит корабль. Доберись до зелёной линии!"]
    flame = False
    while True:
        draw(state, log, MENU, flame)
        choice = ask(["1", "2", "3", "4"])
        if choice is None:
            return None
        flame = False
        if choice == "1" and state["fuel"] >= 22:
            state["fuel"] -= 22
            state["dist"] += 16
            flame = True
            msg = "Двигатели на максимум! +16"
        elif choice == "1":
            msg = "Не хватает топлива для форсажа!"
        elif choice == "2" and state["fuel"] >= 8:
            state["fuel"] -= 8
            state["dist"] += 8
            flame = True
            msg = "Ровный ход. +8"
        elif choice == "2":
            msg = "Топливо на нуле..."
        elif choice == "3":
            state["fuel"] = max(0, state["fuel"] - 8)
            state["hull"] = min(100, state["hull"] + 25)
            msg = "Корпус залатан: +25"
        elif state["cargo"] > 0:
            state["cargo"] -= 1
            state["dist"] += 10
            msg = "Груз за борт! Корабль легче: +10"
        else:
            msg = "Груза больше нет!"
        log = [msg, event(state)]
        pull = 6 + max(0, 100 - state["dist"]) // 14
        state["dist"] -= pull
        log.append(f"Чёрная дыра тянет назад: -{pull}")
        for line in log:
            print(line)
        state["turn"] += 1

        if state["dist"] >= 100:
            state["dist"] = 100
            return finish(state, log, True, f"ПОБЕДА! Ты ушёл за {state['turn'] - 1} ходов")
        if state["dist"] <= 0:
            state["dist"] = 0
            return finish(state, log, False, "Горизонт событий пройден. Связь потеряна")
        if state["hull"] <= 0:
            return finish(state, log, False, "Корпус разрушен. Корабль рассыпался")


def finish(state, log, won, message):
    draw(state, log, [], False)
    color = "#3ddc84" if won else "#ff5c5c"
    text(0, -150, message, color, 18, True, "center")
    screen.update()
    print(message)
    return won


def main():
    wins = games = 0
    while True:
        result = play()
        if result is None:
            break
        games += 1
        wins += bool(result)
        text(0, -190, f"Счёт: {wins} из {games}.  1 - ещё раз, 2 - выход", "white", 13, False, "center")
        screen.update()
        try:
            again = input("Сыграем ещё? (1 - да, 2 - нет): ").strip()
        except EOFError:
            break
        if again != "1":
            break
    screen.update()
    print("Спасибо за игру!")
    turtle.done()


main()
