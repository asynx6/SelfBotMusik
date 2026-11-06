import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, HelpCircle } from "lucide-react";

const DialogContext = createContext(null);

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside <DialogProvider>");
  return ctx;
}

/**
 * Promise-based replacement for window.confirm / window.prompt.
 *
 *   const ok = await confirm({ title: "...", message: "...", danger: true });
 *   const name = await prompt({ title: "...", label: "...", placeholder: "..." });
 *
 * Rendering through a portal keeps the overlay above the persistent player and
 * any stacking context created by the layout.
 */
export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState("");

  const resolverRef = useRef(null);
  const primaryRef = useRef(null);
  const inputRef = useRef(null);
  const restoreFocusRef = useRef(null);

  const open = useCallback((config) => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setValue(config.defaultValue ?? "");
    setDialog(config);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = useCallback((result) => {
    setDialog(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    if (resolve) resolve(result);
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (previous && document.contains(previous)) previous.focus();
  }, []);

  const confirm = useCallback(
    (config) => {
      const options = typeof config === "string" ? { message: config } : config || {};
      return open({ ...options, kind: "confirm" }).then(Boolean);
    },
    [open]
  );

  const prompt = useCallback(
    (config) => {
      const options = typeof config === "string" ? { message: config } : config || {};
      return open({ ...options, kind: "prompt" });
    },
    [open]
  );

  const isPrompt = dialog?.kind === "prompt";

  const accept = useCallback(() => {
    if (!dialog) return;
    if (isPrompt) {
      const trimmed = value.trim();
      if (!trimmed) return; // nothing to submit
      close(trimmed);
    } else {
      close(true);
    }
  }, [dialog, isPrompt, value, close]);

  const cancel = useCallback(() => {
    if (!dialog) return;
    close(isPrompt ? null : false);
  }, [dialog, isPrompt, close]);

  // Focus the right control once the card is mounted.
  useEffect(() => {
    if (!dialog) return;
    const target = isPrompt ? inputRef.current : primaryRef.current;
    target?.focus();
    if (isPrompt) inputRef.current?.select();
  }, [dialog, isPrompt]);

  // Keep the global key handler stable: it must not be torn down and
  // re-registered on every keystroke while the user types into a prompt.
  const acceptRef = useRef(() => {});
  const cancelRef = useRef(() => {});
  acceptRef.current = accept;
  cancelRef.current = cancel;

  // Escape to dismiss, Enter to accept, and no background scrolling.
  useEffect(() => {
    if (!dialog) return;

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        acceptRef.current();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [dialog]);

  // Stable identity so consumers do not re-render on every keystroke.
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const danger = Boolean(dialog?.danger);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog
        ? createPortal(
            <div
              className="dialog-overlay"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) cancel();
              }}
            >
              <div
                className="dialog-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dialog-title"
                aria-describedby={dialog.message ? "dialog-message" : undefined}
              >
                <div className="dialog-header">
                  <div className={`dialog-icon${danger ? " is-danger" : ""}`}>
                    {danger ? <AlertTriangle size={18} /> : <HelpCircle size={18} />}
                  </div>
                  <h2 className="dialog-title" id="dialog-title">
                    {dialog.title || (isPrompt ? "Input" : "Konfirmasi")}
                  </h2>
                </div>

                {dialog.message ? (
                  <p className="dialog-message" id="dialog-message">
                    {dialog.message}
                  </p>
                ) : null}

                {isPrompt ? (
                  <div className="dialog-field">
                    {dialog.label ? <label className="dialog-label">{dialog.label}</label> : null}
                    <input
                      ref={inputRef}
                      className="dialog-input"
                      value={value}
                      placeholder={dialog.placeholder || ""}
                      maxLength={dialog.maxLength || 120}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  </div>
                ) : null}

                <div className="dialog-actions">
                  <button type="button" className="dialog-btn dialog-btn-ghost" onClick={cancel}>
                    {dialog.cancelText || "Batal"}
                  </button>
                  <button
                    ref={primaryRef}
                    type="button"
                    className={`dialog-btn ${danger ? "dialog-btn-danger" : "dialog-btn-primary"}`}
                    onClick={accept}
                    disabled={isPrompt && !value.trim()}
                  >
                    {dialog.confirmText || (isPrompt ? "Simpan" : "Lanjutkan")}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </DialogContext.Provider>
  );
}
