import random

WIDTH = 44


def bar(value, maximum, length=20):
    filled = max(0, min(length, round(length * value / maximum)))
    return "█" * filled + "░" * (length - filled)


def ask(prompt, options):
    """Спрашивает, пока игрок не выберет один из вариантов. Возвращает None, если ввод закончился."""
    while True:
        try:
            answer = input(prompt).strip()
        except EOFError:
            return None
        if answer in options:
            return answer
        print("  Выбери один из пунктов:", ", ".join(options))


def show(state):
    print("\n" + "=" * WIDTH)
    print(f" Ход {state['turn']:>2}   Груз: {state['cargo']} ящ.")
    print(f" Дистанция {bar(state['dist'], 100)} {state['dist']:>3}/100")
    print(f" Топливо   {bar(state['fuel'], 100)} {state['fuel']:>3}")
    print(f" Корпус    {bar(state['hull'], 100)} {state['hull']:>3}")
    print("=" * WIDTH)


def random_event(state):
    roll = random.random()
    if roll < 0.30:
        dmg = random.randint(6, 14)
        state["hull"] -= dmg
        print(f"☄  Поле астероидов! Корпус -{dmg}")
    elif roll < 0.50:
        gain = random.randint(12, 22)
        state["fuel"] = min(100, state["fuel"] + gain)
        print(f"⛽ Нашёл дрейфующий контейнер с топливом: +{gain}")
    elif roll < 0.58:
        state["dist"] -= 5
        print("🌀 Гравитационная волна! Тебя резко потянуло назад: дистанция -5")
    elif roll < 0.68:
        state["cargo"] += 1
        print("📦 Подобрал ящик с запчастями (+1 груз)")
    else:
        print("…космос молчит.")


def play():
    state = {"turn": 1, "dist": 40, "fuel": 100, "hull": 100, "cargo": 3}
    print("\n=== ПОБЕГ ОТ ЧЁРНОЙ ДЫРЫ ===")
    print("Твой корабль ловит гравитация. Доберись до дистанции 100,")
    print("чтобы уйти в безопасность. Каждый ход чёрная дыра тянет назад.\n")

    while True:
        show(state)
        print("1) Форсаж        (+16 дистанции, -22 топлива)")
        print("2) Экономный ход (+8 дистанции, -8 топлива)")
        print("3) Ремонт        (+25 корпуса, -8 топлива)")
        print("4) Сбросить груз (+10 дистанции, -1 ящик)")
        choice = ask("Твой выбор (1-4): ", ["1", "2", "3", "4"])
        if choice is None:
            print("\nВвод закончился, игра остановлена.")
            return None
        print()

        if choice == "1":
            if state["fuel"] < 22:
                print("Не хватает топлива для форсажа! Корабль только дёрнулся.")
            else:
                state["fuel"] -= 22
                state["dist"] += 16
                print("🚀 Двигатели на максимум! Дистанция +16")
        elif choice == "2":
            if state["fuel"] < 8:
                print("Топливо на нуле...")
            else:
                state["fuel"] -= 8
                state["dist"] += 8
                print("Ровный ход. Дистанция +8")
        elif choice == "3":
            state["fuel"] = max(0, state["fuel"] - 8)
            state["hull"] = min(100, state["hull"] + 25)
            print("🔧 Корпус залатан: +25")
        elif state["cargo"] > 0:
            state["cargo"] -= 1
            state["dist"] += 10
            print("📦 Груз за борт! Корабль легче: дистанция +10")
        else:
            print("Груза больше нет!")

        random_event(state)
        pull = 6 + max(0, 100 - state["dist"]) // 14
        state["dist"] -= pull
        print(f"⚫ Чёрная дыра тянет назад: дистанция -{pull}")
        state["turn"] += 1

        if state["dist"] >= 100:
            show(state)
            print("\n🎉 ПОБЕДА! Ты вырвался из гравитации за", state["turn"] - 1, "ходов!")
            return True
        if state["dist"] <= 0:
            show(state)
            print("\n💀 Горизонт событий пройден. Связь потеряна навсегда.")
            return False
        if state["hull"] <= 0:
            show(state)
            print("\n💥 Корпус разрушен. Корабль рассыпался на части.")
            return False


def main():
    wins = games = 0
    while True:
        result = play()
        if result is None:
            break
        games += 1
        wins += bool(result)
        print(f"\nСчёт: {wins} побед из {games} игр.")
        again = ask("Сыграем ещё? (1 - да, 2 - нет): ", ["1", "2"])
        if again != "1":
            print("Спасибо за игру!")
            break


if __name__ == "__main__":
    main()
