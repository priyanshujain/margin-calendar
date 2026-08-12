import { useEffect } from "react";
import { useToast } from "../store/useToast";

const DISMISS_MS = 5000;

export function Toast() {
  const message = useToast((s) => s.message);
  const dismiss = useToast((s) => s.dismiss);

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(dismiss, DISMISS_MS);
    return () => clearTimeout(id);
  }, [message, dismiss]);

  if (!message) return null;
  return (
    <div className="toast" role="status" onClick={dismiss}>
      {message}
    </div>
  );
}

export default Toast;
