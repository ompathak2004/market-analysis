"use client";

import { useActionState } from "react";
import { type LoginState, login } from "@/app/admin/actions";

const INITIAL: LoginState = { error: null };

export function LoginForm() {
  const [state, action, pending] = useActionState(login, INITIAL);
  return (
    <form action={action} className="admin-login">
      <label htmlFor="admin-key" className="section-title">
        Admin key
      </label>
      <input
        id="admin-key"
        name="key"
        type="password"
        className="admin-input"
        autoComplete="current-password"
        spellCheck={false}
        required
      />
      <button type="submit" className="admin-button" disabled={pending}>
        {pending ? "CHECKING…" : "SIGN IN ↵"}
      </button>
      {state.error ? (
        <p role="alert" className="neg sm">
          {state.error}
        </p>
      ) : (
        <p className="muted sm">Opens the SPLC review queue for 12 hours on this browser.</p>
      )}
    </form>
  );
}
