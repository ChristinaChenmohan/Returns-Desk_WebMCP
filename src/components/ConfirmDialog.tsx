import { useEffect, useRef, type ReactNode } from "react";
export function ConfirmDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.showModal(); return () => previous?.focus(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={onClose}><div className="dialog-heading"><h2>{title}</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></div>{children}</dialog>;
}
