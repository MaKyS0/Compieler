import { LogOut } from "lucide-react";
import { useState } from "react";
import { useProject } from "../store/project";
import { STANDALONE } from "../runtime/mode";
import { useUI } from "../store/ui";
import { Modal } from "./Dialogs";

export function AuthModal() {
  const close = () => useUI.getState().openModal(null);
  const user = useProject((s) => s.user);
  const config = useProject((s) => s.config);
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (STANDALONE) {
    return (
      <Modal title="This device" onClose={close} width={400}>
        <div className="flex flex-col gap-2 p-3 text-[12.5px] leading-relaxed">
          <p>
            You are using the <b>offline app</b>: projects are stored on this device (inside the app) and code runs here, with no account or server.
          </p>
          <p className="text-dim">Use <b>Projects → Export as ZIP</b> to back your work up or move it to another device.</p>
        </div>
      </Modal>
    );
  }
  if (user && !user.is_guest) {
    return (
      <Modal title="Account" onClose={close} width={360}>
        <div className="flex flex-col gap-3 p-3 text-[12.5px]">
          <p>
            Signed in as <b>{user.email}</b>. Your projects are stored on the server and available from any device.
          </p>
          <button className="btn btn-solid self-start" onClick={async () => (close(), await useProject.getState().logout())}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </Modal>
    );
  }

  const canRegister = config?.allow_registration !== false;
  return (
    <Modal title={mode === "register" ? "Create account" : "Sign in"} onClose={close} width={380}>
      <form
        className="flex flex-col gap-3 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setBusy(true);
          try {
            if (mode === "register") await useProject.getState().register(email, password);
            else await useProject.getState().login(email, password);
            close();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-[12px] leading-relaxed text-dim">
          You are using a <b className="text-fg">temporary guest session</b>: projects are kept in this browser's session token only.
          {mode === "register" ? " Create an account to keep them permanently — your current projects will be moved into it." : " Projects from this guest session will be merged into your account."}
        </p>
        <label className="flex flex-col gap-1 text-[12px]">
          E-mail
          <input className="field !h-8" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          Password {mode === "register" && <span className="text-dim">(at least 8 characters)</span>}
          <input className="field !h-8" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="text-[12px] text-err">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between">
          {canRegister || mode === "login" ? (
            <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => (setMode(mode === "login" ? "register" : "login"), setError(""))}>
              {mode === "login" ? "Need an account? Register" : "Already registered? Sign in"}
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-solid !border-accent/60 !bg-accent/20" disabled={busy}>
            {mode === "register" ? "Create account" : "Sign in"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
