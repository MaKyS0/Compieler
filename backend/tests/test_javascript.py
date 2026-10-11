import pytest

JS = lambda s: {"index.js": s}


async def test_console_log_and_exit(user):
    pid = user.create_project("javascript", JS("console.log('hi', 1 + 1, [1,2], {a:1}); console.error('oops')"))
    r = await user.run(pid, entry="index.js")
    assert r.stdout == "hi 2 [ 1, 2 ] { a: 1 }\n"
    assert r.stderr == "oops\n"
    assert r.exit["code"] == 0 and r.exit["reason"] == "ok"


async def test_modern_syntax_and_async(user):
    code = """
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class A { #x = 5; get x() { return this.#x; } }
const { a = 3, ...rest } = { b: 1, c: 2 };
(async () => {
  await sleep(20);
  const r = await Promise.all([1, 2, 3].map(async n => n * 2));
  console.log(r, new A().x, a, rest, [1,2,3].at(-1), structuredClone({z: 1}));
})();
"""
    pid = user.create_project("javascript", JS(code))
    r = await user.run(pid, entry="index.js")
    assert r.exit["reason"] == "ok", r.all_text
    assert r.stdout == "[ 2, 4, 6 ] 5 3 { b: 1, c: 2 } 3 { z: 1 }\n"


async def test_node_core_modules(user):
    code = """
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const http = require('http'), https = require('https'), url = require('url'), util = require('util');
const EventEmitter = require('events'), { Readable } = require('stream'), { Buffer } = require('buffer');
const timers = require('timers');
console.log(crypto.createHash('sha256').update('abc').digest('hex').slice(0, 16));
console.log(path.join('a', '..', 'b'), typeof os.cpus, util.format('%s=%d', 'x', 5), new url.URL('http://x.y/z?q=1').searchParams.get('q'));
const e = new EventEmitter(); e.on('ev', v => console.log('event', v)); e.emit('ev', 7);
console.log(Buffer.from('héllo').length, process.argv.length, typeof process.env.PATH);
Readable.from(['x', 'y']).on('data', d => console.log('stream', d));
"""
    pid = user.create_project("javascript", JS(code))
    r = await user.run(pid, entry="index.js")
    assert r.exit["reason"] == "ok", r.all_text
    assert r.stdout.startswith("ba7816bf8f01cfea\n")
    assert "event 7" in r.stdout and "stream x" in r.stdout and "b 7 x=5 1" not in r.stdout
    assert "b function x=5 1" in r.stdout


async def test_fs_in_project_directory(user):
    code = """
const fs = require('fs');
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/a.txt', 'node-file');
console.log(fs.readFileSync('out/a.txt', 'utf8'), fs.readdirSync('.').includes('out'));
"""
    pid = user.create_project("javascript", JS(code))
    r = await user.run(pid, entry="index.js")
    assert r.stdout == "node-file true\n", r.all_text
    assert user.http.get(f"/projects/{pid}/file", params={"path": "out/a.txt"}).json()["content"] == "node-file"


async def test_uncaught_exception(user):
    code = "function boom() {\n  throw new TypeError('bad thing');\n}\nconsole.log('start');\nboom();\n"
    pid = user.create_project("javascript", JS(code))
    r = await user.run(pid, entry="index.js")
    assert r.stdout == "start\n"
    assert "TypeError: bad thing" in r.stderr
    assert r.exit["code"] == 1 and r.exit["reason"] == "error"
    assert r.problems and r.problems[0]["file"] == "index.js" and r.problems[0]["line"] == 2


async def test_syntax_error(user):
    pid = user.create_project("javascript", JS("let x = ;\n"))
    r = await user.run(pid, entry="index.js")
    assert "SyntaxError" in r.stderr and r.exit["reason"] == "error"
    assert r.problems and r.problems[0]["line"] == 1


async def test_readline_interactive_input(user):
    code = """
const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
rl.question('Your name? ', n => { console.log('Hello ' + n); rl.close(); });
"""
    pid = user.create_project("javascript", JS(code))
    r = await user.execute(pid, {"type": "run", "entry": "index.js"}, script=[("Your name? ", {"type": "stdin", "data": "Linus\n"})])
    assert r.stdout.endswith("Hello Linus\n") and r.exit["reason"] == "ok"


async def test_multi_file_commonjs_and_esm(user):
    cjs = user.create_project("javascript", {"index.js": "console.log(require('./lib/m').twice(21))", "lib/m.js": "exports.twice = x => x * 2;"})
    assert (await user.run(cjs, entry="index.js")).stdout == "42\n"
    esm = user.create_project("javascript", {
        "package.json": '{"type":"module"}',
        "index.js": "import { twice } from './m.js'; console.log(twice(4));",
        "m.js": "export const twice = x => x * 2;",
    })
    r = await user.run(esm, entry="index.js")
    assert r.stdout == "8\n", r.all_text


async def test_missing_package_hint(user):
    pid = user.create_project("javascript", JS("require('not-installed-pkg')"))
    r = await user.run(pid, entry="index.js")
    assert "Cannot find module" in r.stderr and "npm install not-installed-pkg" in r.system


@pytest.mark.network
async def test_npm_dependency_from_package_json(user):
    files = {
        "package.json": '{"name":"p","version":"1.0.0","dependencies":{"is-odd":"3.0.1"}}',
        "index.js": "console.log(require('is-odd')(3), require('is-odd')(4));",
    }
    pid = user.create_project("javascript", files)
    r = await user.run(pid, entry="index.js")
    assert r.exit["reason"] == "ok", r.all_text
    assert r.stdout == "true false\n" and "Installing npm dependencies" in r.system
    again = await user.run(pid, entry="index.js")
    assert again.stdout == "true false\n" and "Installing" not in again.all_text


@pytest.mark.network
async def test_install_package_from_panel(user):
    pid = user.create_project("javascript", JS("console.log(require('is-number')(5))"))
    r = await user.execute(pid, {"type": "install", "packages": ["is-number@7.0.0"]})
    assert r.exit["reason"] == "ok", r.all_text
    pkg = user.http.get(f"/projects/{pid}/file", params={"path": "package.json"}).json()["content"]
    assert "is-number" in pkg
    assert (await user.run(pid, entry="index.js")).stdout == "true\n"
