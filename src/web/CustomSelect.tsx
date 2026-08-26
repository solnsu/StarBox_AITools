import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type CustomSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

type CustomSelectProps = {
  value: string;
  options: readonly CustomSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  icon?: ReactNode;
  tone?: 'light' | 'dark';
  menuPlacement?: 'auto' | 'top' | 'bottom';
  minMenuWidth?: number;
};

type MenuPosition = Pick<CSSProperties, 'top' | 'left' | 'width' | 'maxHeight'>;

export function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  className = '',
  icon,
  tone = 'light',
  menuPlacement = 'auto',
  minMenuWidth = 168,
}: CustomSelectProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0, width: minMenuWidth, maxHeight: 280 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(options.length * 48 + 12, 280);
    const spaceAbove = rect.top - 8;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const placeAbove = menuPlacement === 'top' || (menuPlacement === 'auto' && spaceBelow < Math.min(estimatedHeight, 180) && spaceAbove > spaceBelow);
    const maxHeight = Math.max(96, Math.min(280, placeAbove ? spaceAbove - 7 : spaceBelow - 7));
    const actualHeight = Math.min(menuRef.current?.offsetHeight ?? estimatedHeight, maxHeight);
    const width = Math.min(Math.max(rect.width, minMenuWidth), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const top = placeAbove ? Math.max(8, rect.top - actualHeight - 7) : rect.bottom + 7;
    setPosition({ top, left, width, maxHeight });
  }, [menuPlacement, minMenuWidth, options.length]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnViewportChange = (event?: Event) => {
      // Keep the menu open while its own scroll container is being scrolled.
      if (event && menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, options.findIndex((option) => !option.disabled)));
  }, [open, options, selectedIndex]);

  const moveActive = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = activeIndex;
    do { next = (next + direction + options.length) % options.length; } while (options[next]?.disabled && next !== activeIndex);
    setActiveIndex(next);
  };

  const choose = (option: CustomSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' && open) {
      event.preventDefault(); setActiveIndex(Math.max(0, options.findIndex((option) => !option.disabled)));
    } else if (event.key === 'End' && open) {
      event.preventDefault();
      const last = options.map((option) => !option.disabled).lastIndexOf(true);
      setActiveIndex(Math.max(0, last));
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault(); setOpen(false);
    }
  };

  return <div className={`custom-select ${tone} ${className}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="custom-select-trigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${id}-listbox`}
      disabled={disabled || !options.length}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onKeyDown}
    >
      {icon ? <span className="custom-select-icon">{icon}</span> : null}
      <span className={`custom-select-value${selected ? '' : ' placeholder'}`}>{selected?.label ?? placeholder ?? ariaLabel}</span>
      <ChevronDown className="custom-select-chevron" aria-hidden="true" />
    </button>
    {open ? createPortal(<div
      ref={menuRef}
      id={`${id}-listbox`}
      className={`custom-select-menu ${tone} cp-sidebar-scrollbar`}
      role="listbox"
      aria-label={ariaLabel}
      style={position}
    >
      {options.map((option, index) => <button
        type="button"
        role="option"
        aria-selected={option.value === value}
        className={`custom-select-option${option.value === value ? ' selected' : ''}${index === activeIndex ? ' active' : ''}`}
        disabled={option.disabled}
        key={option.value}
        onPointerMove={() => setActiveIndex(index)}
        onClick={() => choose(option)}
      >
        {option.icon ? <span className="custom-select-option-icon">{option.icon}</span> : null}
        <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
        {option.value === value ? <Check aria-hidden="true" /> : null}
      </button>)}
    </div>, document.body) : null}
  </div>;
}
