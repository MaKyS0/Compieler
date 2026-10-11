import pytest

HELLO = '#include <iostream>\nint main(){ std::cout << "Hello from C++\\n"; return 0; }\n'


async def test_compile_and_run(user):
    pid = user.create_project("cpp", {"main.cpp": HELLO})
    r = await user.run(pid, entry="main.cpp")
    assert r.stdout == "Hello from C++\n"
    assert r.exit["code"] == 0 and r.exit["reason"] == "ok"
    assert "g++" in r.log("system")


async def test_cin_cout(user):
    code = '#include <iostream>\n#include <string>\nint main(){ std::string n; int a; std::cout << "Name: "; std::cin >> n >> a; std::cout << n << " " << a * 2 << "\\n"; }\n'
    pid = user.create_project("cpp", {"main.cpp": code})
    r = await user.run(pid, entry="main.cpp", stdin="Eve 21\n")
    assert r.stdout == "Name: Eve 42\n"


async def test_printf_prompt_is_visible_before_scanf(user):
    """printf without newline must show up *before* input is given (interactive use)."""
    code = '#include <cstdio>\nint main(){ int x; printf("Enter x: "); scanf("%d", &x); printf("x*x=%d\\n", x*x); }\n'
    pid = user.create_project("cpp", {"main.cpp": code})
    r = await user.execute(pid, {"type": "run", "entry": "main.cpp"}, script=[("Enter x: ", {"type": "stdin", "data": "9\n"})])
    assert r.stdout == "Enter x: x*x=81\n"


async def test_exit_code_is_reported(user):
    pid = user.create_project("cpp", {"main.cpp": "int main(){ return 3; }"})
    r = await user.run(pid, entry="main.cpp")
    assert r.exit["code"] == 3 and r.exit["reason"] == "error"


async def test_syntax_error_produces_diagnostics(user):
    code = '#include <iostream>\nint main(){\n    int x = ;\n    std::cout << x\n}\n'
    pid = user.create_project("cpp", {"main.cpp": code})
    r = await user.run(pid, entry="main.cpp")
    assert r.exit["reason"] == "compile_error"
    assert r.stdout == ""
    assert "error:" in r.log("compile")
    errors = [p for p in r.problems if p["severity"] == "error"]
    assert errors and errors[0]["file"] == "main.cpp" and errors[0]["line"] == 3
    assert not [e for e in r.events if e["type"] == "output" and e["phase"] == "run"]


async def test_warnings_are_reported_but_program_runs(user):
    code = '#include <iostream>\nint main(){ int unused; std::cout << "ran\\n"; }\n'
    pid = user.create_project("cpp", {"main.cpp": code})
    r = await user.run(pid, entry="main.cpp")
    assert r.stdout == "ran\n"
    warns = [p for p in r.problems if p["severity"] == "warning"]
    assert warns and warns[0]["line"] == 2


async def test_multiple_source_files_and_headers(user):
    files = {
        "main.cpp": '#include "mathx.h"\n#include <iostream>\nint main(){ std::cout << add(40, 2) << "\\n"; }\n',
        "mathx.h": "#pragma once\nint add(int,int);\n",
        "mathx.cpp": '#include "mathx.h"\nint add(int a,int b){ return a+b; }\n',
        "lib/extra.cpp": "int unused_helper(){ return 1; }\n",
    }
    pid = user.create_project("cpp", files)
    r = await user.run(pid, entry="main.cpp")
    assert r.stdout == "42\n", r.all_text


async def test_errors_in_secondary_file_are_attributed(user):
    files = {"main.cpp": "int f(); int main(){ return f(); }", "f.cpp": "int f(){ return undefined_name; }"}
    pid = user.create_project("cpp", files)
    r = await user.run(pid, entry="main.cpp")
    assert r.exit["reason"] == "compile_error"
    assert any(p["file"] == "f.cpp" and p["line"] == 1 for p in r.problems)


# gcc 13 reports 202100 for -std=c++23, gcc 14+ reports 202302
@pytest.mark.parametrize("std,minimum", [("c++17", 201703), ("c++20", 202002), ("c++23", 202100)])
async def test_cpp_standards(user, std, minimum):
    pid = user.create_project("cpp", {"main.cpp": '#include <iostream>\nint main(){ std::cout << __cplusplus; }'})
    r = await user.run(pid, entry="main.cpp", std=std)
    assert r.exit["reason"] == "ok", r.all_text
    assert int(r.stdout) >= minimum
    if std != "c++23":
        assert int(r.stdout) == minimum


async def test_stl_containers_and_algorithms(user):
    code = '''#include <algorithm>
#include <map>
#include <numeric>
#include <vector>
#include <iostream>
int main(){ std::vector<int> v{5,3,9,1}; std::sort(v.begin(), v.end());
  std::map<std::string,int> m{{"a",1}}; std::cout << v.front() << v.back() << std::accumulate(v.begin(), v.end(), 0) << m["a"] << "\\n"; }'''
    pid = user.create_project("cpp", {"main.cpp": code})
    r = await user.run(pid, entry="main.cpp")
    assert r.stdout == "19181\n", r.all_text


async def test_build_is_cached_when_sources_do_not_change(user):
    pid = user.create_project("cpp", {"main.cpp": HELLO})
    first = await user.run(pid, entry="main.cpp")
    second = await user.run(pid, entry="main.cpp")
    assert "using cached build" not in first.system
    assert "using cached build" in second.system and second.stdout == first.stdout
    user.http.put(f"/projects/{pid}/file", json={"path": "main.cpp", "content": HELLO.replace("Hello", "Bye")})
    third = await user.run(pid, entry="main.cpp")
    assert third.stdout == "Bye from C++\n"


async def test_segfault_is_reported_as_signal(user):
    pid = user.create_project("cpp", {"main.cpp": "int main(){ int *p = nullptr; return *p; }"})
    r = await user.run(pid, entry="main.cpp")
    assert r.exit["signal"] == "SIGSEGV" and r.exit["reason"] == "signal"


async def test_two_programs_in_one_project_build_the_selected_one(user):
    files = {"a.cpp": 'int main(){ return 11; }', "b.cpp": 'int main(){ return 22; }'}
    pid = user.create_project("cpp", files)
    assert (await user.run(pid, entry="a.cpp")).exit["code"] == 11
    assert (await user.run(pid, entry="b.cpp")).exit["code"] == 22
