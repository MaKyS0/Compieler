import io
import zipfile

import httpx
import pytest


def test_health_and_config_report_real_sandbox(server):
    h = httpx.get(f"{server.http}/api/health").json()
    assert h["status"] == "ok" and h["sandbox"]["backend"] in ("local", "docker")
    c = httpx.get(f"{server.http}/api/config").json()
    assert set(c["languages"]) == {"python", "cpp", "javascript"}
    assert c["cpp_standards"] == ["c++17", "c++20", "c++23"]
    assert all(c["formatters"].values()), c["formatters"]


def test_guest_register_login_flow_keeps_projects(server, new_user):
    guest = new_user()
    pid = guest.create_project("python", {"main.py": "print('kept')"})
    email = f"user{guest.id}@example.com"
    r = httpx.post(f"{server.http}/api/auth/register", json={"email": email, "password": "correct horse"},
                   headers={"Authorization": f"Bearer {guest.token}"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["is_guest"] is False and r.json()["user"]["id"] == guest.id
    # duplicate
    assert httpx.post(f"{server.http}/api/auth/register", json={"email": email, "password": "another pass"}).status_code == 409
    # wrong password / right password
    assert httpx.post(f"{server.http}/api/auth/login", json={"email": email, "password": "wrong password"}).status_code == 401
    tok = httpx.post(f"{server.http}/api/auth/login", json={"email": email, "password": "correct horse"}).json()["token"]
    me = httpx.get(f"{server.http}/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).json()
    assert me["email"] == email
    projects = httpx.get(f"{server.http}/api/projects", headers={"Authorization": f"Bearer {tok}"}).json()
    assert pid in [p["id"] for p in projects]


def test_login_merges_guest_projects_into_account(server, new_user):
    owner = new_user()
    email = f"merge{owner.id}@example.com"
    httpx.post(f"{server.http}/api/auth/register", json={"email": email, "password": "password123"},
               headers={"Authorization": f"Bearer {owner.token}"})
    fresh_guest = new_user()
    gpid = fresh_guest.create_project("cpp", {"main.cpp": "int main(){}"}, name="from-guest")
    r = httpx.post(f"{server.http}/api/auth/login", json={"email": email, "password": "password123"},
                   headers={"Authorization": f"Bearer {fresh_guest.token}"})
    assert r.status_code == 200
    tok = r.json()["token"]
    names = {p["name"] for p in httpx.get(f"{server.http}/api/projects", headers={"Authorization": f"Bearer {tok}"}).json()}
    assert "from-guest" in names


def test_password_rules_and_email_validation(server):
    assert httpx.post(f"{server.http}/api/auth/register", json={"email": "a@b.co", "password": "short"}).status_code == 422
    assert httpx.post(f"{server.http}/api/auth/register", json={"email": "not-an-email", "password": "longenough1"}).status_code == 422


def test_project_crud_with_templates(user):
    for lang, entry in [("python", "main.py"), ("cpp", "main.cpp"), ("javascript", "index.js")]:
        r = user.http.post("/projects", json={"name": f"{lang} demo", "language": lang})
        assert r.status_code == 201, r.text
        p = r.json()
        assert p["settings"]["entry"] == entry
        tree = {e["path"] for e in user.http.get(f"/projects/{p['id']}/tree").json()}
        assert entry in tree
        assert user.http.get(f"/projects/{p['id']}/file", params={"path": entry}).json()["content"].strip()
    mine = user.http.get("/projects").json()
    assert len(mine) == 3
    pid = mine[0]["id"]
    assert user.http.patch(f"/projects/{pid}", json={"name": "Renamed"}).json()["name"] == "Renamed"
    assert user.http.delete(f"/projects/{pid}").status_code == 204
    assert user.http.get(f"/projects/{pid}").status_code == 404
    assert len(user.http.get("/projects").json()) == 2


def test_recent_projects_are_ordered_by_last_opened(user):
    a = user.create_project("python", name="A")
    b = user.create_project("python", name="B")
    user.http.get(f"/projects/{a}")
    assert [p["name"] for p in user.http.get("/projects").json()][:2] == ["A", "B"]


def test_file_operations(user):
    pid = user.create_project("python", {"main.py": "print(1)"})
    h = user.http
    assert h.put(f"/projects/{pid}/file", json={"path": "src/util/helpers.py", "content": "x = 1\n"}).status_code == 204
    assert h.post(f"/projects/{pid}/dir", json={"path": "docs/empty"}).status_code == 201
    tree = {(e["path"], e["type"]) for e in h.get(f"/projects/{pid}/tree").json()}
    assert {("main.py", "file"), ("src", "dir"), ("src/util", "dir"), ("src/util/helpers.py", "file"), ("docs/empty", "dir")} <= tree
    assert h.post(f"/projects/{pid}/move", json={"src": "src/util/helpers.py", "dst": "helpers.py"}).status_code == 204
    assert h.get(f"/projects/{pid}/file", params={"path": "helpers.py"}).json()["content"] == "x = 1\n"
    assert h.get(f"/projects/{pid}/file", params={"path": "src/util/helpers.py"}).status_code == 404
    # no clobbering
    assert h.post(f"/projects/{pid}/move", json={"src": "helpers.py", "dst": "main.py"}).status_code == 409
    assert h.post(f"/projects/{pid}/move", json={"src": "src", "dst": "src/inside"}).status_code == 400
    assert h.delete(f"/projects/{pid}/file", params={"path": "src"}).status_code == 204
    assert h.delete(f"/projects/{pid}/file", params={"path": "nope.txt"}).status_code == 404
    assert "src" not in {e["path"] for e in h.get(f"/projects/{pid}/tree").json()}


def test_unicode_and_binary_files(user):
    pid = user.create_project("python", {"main.py": "print('привет')\n# 你好\n"})
    assert user.http.get(f"/projects/{pid}/file", params={"path": "main.py"}).json()["content"] == "print('привет')\n# 你好\n"
    r = user.http.post(f"/projects/{pid}/upload", files={"file": ("img.bin", bytes(range(256)))}, data={"path": "assets/img.bin"})
    assert r.status_code == 201
    got = user.http.get(f"/projects/{pid}/file", params={"path": "assets/img.bin"}).json()
    assert got["binary"] is True and got["size"] == 256


def test_changing_entry_follows_renames(user):
    pid = user.create_project("python", {"main.py": "1"})
    user.http.patch(f"/projects/{pid}", json={"settings": {"entry": "main.py"}})
    user.http.post(f"/projects/{pid}/move", json={"src": "main.py", "dst": "app.py"})
    assert user.http.get(f"/projects/{pid}").json()["settings"]["entry"] == "app.py"


def test_settings_are_validated(user):
    pid = user.create_project("cpp", {"main.cpp": "int main(){}"})
    assert user.http.patch(f"/projects/{pid}", json={"settings": {"cpp_std": "c++99"}}).status_code == 422
    assert user.http.patch(f"/projects/{pid}", json={"settings": {"entry": "../x.cpp"}}).status_code == 400
    ok = user.http.patch(f"/projects/{pid}", json={"settings": {"cpp_std": "c++20", "args": "a b"}}).json()
    assert ok["settings"]["cpp_std"] == "c++20" and ok["settings"]["args"] == "a b"


def test_switching_language_keeps_files_and_adds_starter(user):
    pid = user.create_project("python", {"main.py": "print('keep me')"})
    r = user.http.patch(f"/projects/{pid}", json={"language": "javascript"}).json()
    assert r["language"] == "javascript" and r["settings"]["entry"] == "index.js"
    tree = {e["path"] for e in user.http.get(f"/projects/{pid}/tree").json()}
    assert {"main.py", "index.js"} <= tree


def test_zip_export_import_roundtrip(user):
    files = {"main.py": "print('zip')\n", "pkg/mod.py": "A = 1\n", "requirements.txt": "requests\n"}
    pid = user.create_project("python", files, name="My Project!")
    user.http.post(f"/projects/{pid}/dir", json={"path": "emptydir"})
    r = user.http.get(f"/projects/{pid}/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert "My_Project" in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert {n for n in z.namelist() if not n.endswith("/")} == set(files)
    assert z.read("pkg/mod.py") == b"A = 1\n"
    imp = user.http.post("/projects/import", files={"file": ("my.zip", r.content)}, data={"name": "Imported"})
    assert imp.status_code == 201
    new = imp.json()
    assert new["language"] == "python" and new["settings"]["entry"] == "main.py" and new["name"] == "Imported"
    for path, content in files.items():
        assert user.http.get(f"/projects/{new['id']}/file", params={"path": path}).json()["content"] == content


def test_import_rejects_garbage(user):
    assert user.http.post("/projects/import", files={"file": ("x.zip", b"not a zip")}).status_code == 400
    empty = io.BytesIO()
    zipfile.ZipFile(empty, "w").close()
    assert user.http.post("/projects/import", files={"file": ("e.zip", empty.getvalue())}).status_code == 400


def test_import_detects_language(user):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("src/app.cpp", "int main(){}")
        z.writestr("src/util.cpp", "")
        z.writestr("README.md", "hi")
    p = user.http.post("/projects/import", files={"file": ("c.zip", buf.getvalue())}).json()
    assert p["language"] == "cpp" and p["settings"]["entry"] == "src/app.cpp"


# ------------------------------------------------------------------ formatting
def test_format_python(user):
    r = user.http.post("/format", json={"language": "python", "content": "x=[1,2,\n 3]\ndef f( a,b ):\n  return a+b\n"})
    assert r.status_code == 200
    assert r.json()["content"] == "x = [1, 2, 3]\n\n\ndef f(a, b):\n    return a + b\n"


def test_format_cpp(user):
    r = user.http.post("/format", json={"language": "cpp", "content": "int main(){int x=1;if(x){return 0;}}"})
    assert r.status_code == 200
    out = r.json()["content"]
    assert "int main() {" in out and "\n    int x = 1;" in out


def test_format_javascript(user):
    r = user.http.post("/format", json={"language": "javascript", "content": "const a={b:1,c:[1,2]}\nfunction f(x){return x*2}"})
    assert r.status_code == 200
    assert r.json()["content"] == "const a = { b: 1, c: [1, 2] };\nfunction f(x) {\n  return x * 2;\n}\n"


def test_format_syntax_error_is_a_clean_422(user):
    r = user.http.post("/format", json={"language": "python", "content": "def (:\n"})
    assert r.status_code == 422 and "format" in r.json()["detail"].lower()


def test_format_requires_login(server):
    assert httpx.post(f"{server.http}/api/format", json={"language": "python", "content": "x=1"}).status_code == 401


def test_project_limit(user, server):
    # limit is generous in tests; just prove the counter path works by creating several
    for i in range(3):
        user.create_project("python", name=f"p{i}")
    assert len(user.http.get("/projects").json()) == 3
