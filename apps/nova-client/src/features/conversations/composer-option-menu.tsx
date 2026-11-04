import { Button } from '@/components/ui/button';
import { Description, Label, ListBox, Popover } from '@heroui/react';
import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export function ComposerOptionMenu({
  label,
  value,
  options,
  disabled,
  icon,
  onChange,
}: {
  label: string;
  value?: string | undefined;
  options: readonly { value: string; label: string; description?: string; disabled?: boolean }[];
  disabled: boolean;
  icon: ReactNode;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="ghost" disabled={disabled} aria-label={label}>
        <span aria-hidden="true" className="[&_svg]:size-4">
          {icon}
        </span>
        <span className="text-xs">
          {options.find((option) => option.value === value)?.label ?? label}
        </span>
        <ChevronDown size={12} />
      </Button>
      <Popover.Content placement="top end">
        <Popover.Dialog>
          <ListBox
            aria-label={label}
            selectionMode="single"
            selectedKeys={new Set(value ? [value] : [])}
            onSelectionChange={(keys) => {
              const key = keys === 'all' ? undefined : Array.from(keys)[0];
              if (key !== undefined) {
                onChange(String(key));
                setOpen(false);
              }
            }}
            disabledKeys={options.filter((option) => option.disabled).map((option) => option.value)}
            onAction={(key) => {
              onChange(String(key));
              setOpen(false);
            }}
          >
            {options.map((option) => (
              <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                <div>
                  <Label>{option.label}</Label>
                  {option.description && <Description>{option.description}</Description>}
                </div>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
