"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock3 } from "lucide-react";
import { Popover } from "radix-ui";

type TimeFieldProps = {
  id: string;
  value: string;
  onValueChange(value: string): void;
  allowClear?: boolean;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  "aria-label"?: string;
};

function normalizedTime(text: string) {
  const compact = text.trim().replace("：", ":");
  const match = compact.match(/^(\d{1,2}):(\d{1,2})$/) ?? compact.match(/^(\d{1,2})(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return match[1].padStart(2, "0") + ":" + match[2].padStart(2, "0");
}

function TimeColumn({ label, selected, count, onSelect }: { label: string; selected: string; count: number; onSelect(value: string): void }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const centered = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    if (!centered.current) {
      list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
      centered.current = true;
    } else if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [selected]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction = ({ ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 } as Record<string, number>)[event.key];
    if (direction === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (Number(selected) + direction + count) % count;
    const next = String(index).padStart(2, "0");
    onSelect(next);
    listRef.current?.querySelector<HTMLButtonElement>('[data-value="' + next + '"]')?.focus({ preventScroll: true });
  }

  return <div className="time-picker-column"><span className="time-picker-column-label">{label}</span><div ref={listRef} className="time-picker-list" role="listbox" aria-label={label} onKeyDown={onKeyDown}>
    {Array.from({ length: count }, (_, index) => String(index).padStart(2, "0")).map(option => <button key={option} type="button" role="option" className="time-picker-option" data-value={option} aria-selected={selected === option} tabIndex={selected === option ? 0 : -1} onClick={() => onSelect(option)}>{option}</button>)}
  </div></div>;
}

export function TimeField({ id, value, onValueChange, allowClear = true, disabled, required, placeholder = "--:--", "aria-label": ariaLabel }: TimeFieldProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [selection, setSelection] = useState({ hour: "09", minute: "00" });

  function commitTyped() {
    if (typed === null) return;
    const normalized = normalizedTime(typed);
    if (normalized) onValueChange(normalized);
    else if (!typed.trim() && allowClear) onValueChange("");
    setTyped(null);
  }

  function changeOpen(next: boolean) {
    if (next) {
      const current = normalizedTime(typed ?? value) ?? normalizedTime(value) ?? "09:00";
      const [hour, minute] = current.split(":");
      setSelection({ hour, minute });
    }
    setOpen(next);
  }

  function apply(next: string) {
    onValueChange(next);
    setTyped(null);
    setOpen(false);
  }

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Anchor asChild><div className="time-field" data-state={open ? "open" : "closed"}>
      <input id={id} className="time-field-input" type="text" inputMode="numeric" autoComplete="off" maxLength={5} value={typed ?? value} placeholder={placeholder} aria-label={ariaLabel} disabled={disabled} required={required} onChange={event => setTyped(event.target.value)} onBlur={commitTyped} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); commitTyped(); }
        else if (event.key === "Escape") setTyped(null);
        else if (event.key === "ArrowDown" && event.altKey) { event.preventDefault(); changeOpen(true); }
      }} />
      <Popover.Trigger asChild><button type="button" className="time-field-trigger" aria-label="选择时间" disabled={disabled}><Clock3 size={16} strokeWidth={1.8} aria-hidden="true" /></button></Popover.Trigger>
    </div></Popover.Anchor>
    <Popover.Portal><Popover.Content className="app-select-content time-picker-content" aria-label="选择时间" sideOffset={7} align="start" collisionPadding={12}>
      <div className="time-picker-header"><span>选择时间</span><strong>{selection.hour}<span>:</span>{selection.minute}</strong></div>
      <div className="time-picker-columns"><TimeColumn label="小时" selected={selection.hour} count={24} onSelect={hour => setSelection(current => ({ ...current, hour }))} /><span className="time-picker-colon" aria-hidden="true">:</span><TimeColumn label="分钟" selected={selection.minute} count={60} onSelect={minute => setSelection(current => ({ ...current, minute }))} /></div>
      <div className="time-picker-actions">{allowClear && <button className="time-picker-clear" type="button" onClick={() => apply("")}>清空</button>}<button type="button" className="time-picker-confirm" onClick={() => apply(selection.hour + ":" + selection.minute)}>确定</button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
