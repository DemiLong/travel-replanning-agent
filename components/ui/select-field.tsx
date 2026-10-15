"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";

type SelectOption = { value: string; label: string; disabled?: boolean };
type SelectFieldProps = {
  id: string;
  value: string;
  options: SelectOption[];
  onValueChange(value: string): void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
};

const EMPTY_VALUE = "__covered_you_unset__";

export function SelectField({ id, value, options, onValueChange, disabled, name, required }: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  return <SelectPrimitive.Root open={open} onOpenChange={setOpen} value={value || EMPTY_VALUE} onValueChange={next => onValueChange(next === EMPTY_VALUE ? "" : next)} disabled={disabled} name={name} required={required}>
    <SelectPrimitive.Trigger id={id} className="app-select-trigger">
      <SelectPrimitive.Value />
      <SelectPrimitive.Icon className="app-select-icon">{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className="app-select-content" position="popper" sideOffset={6} align="start" collisionPadding={12}>
        <SelectPrimitive.Viewport className="app-select-viewport">
          {options.map(option => <SelectPrimitive.Item className="app-select-option" key={option.value} value={option.value || EMPTY_VALUE} disabled={option.disabled}>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="app-select-check"><Check size={14} strokeWidth={2} /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}
