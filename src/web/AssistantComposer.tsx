import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, Plus, X } from 'lucide-react';
import { SolnSpin } from './SolnSpin';
import { CustomSelect } from './CustomSelect';

// Extracted from assistant-ui's Base Composer and attachment components.
// Upstream: apps/docs/components/examples/base.tsx
// Upstream: packages/ui/src/components/assistant-ui/attachment.tsx
// The assistant-ui runtime primitives are represented by native controls here so
// this UI-only extraction can run inside the existing Vite application.

type ComposerAttachment = { id: string; file: File; src: string };
const imageSizes = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;
const imageQualities = ['auto', 'low', 'medium', 'high'] as const;
export type ImageSize = typeof imageSizes[number];
export type ImageQuality = typeof imageQualities[number];

type AssistantComposerProps = {
  addAttachmentLabel: string;
  disabled?: boolean;
  loadingLabel: string;
  models: Array<{ id: string; label: string }>;
  modelsLoading: boolean;
  modelLabel: string;
  modelIcon: ReactNode;
  sizeLabel: string;
  qualityLabel: string;
  sizeOptions: Array<{ value: ImageSize; label: string }>;
  qualityOptions: Array<{ value: ImageQuality; label: string }>;
  imageSize: ImageSize;
  imageQuality: ImageQuality;
  onImageSizeChange: (size: ImageSize) => void;
  onImageQualityChange: (quality: ImageQuality) => void;
  placeholder: string;
  removeAttachmentLabel: string;
  sendLabel: string;
  onInvalidAttachments: (reason: 'limit' | 'invalid') => void;
  onSend: (message: { text: string; model: string; size: ImageSize; quality: ImageQuality; attachments: Array<{ name: string; url: string; dataUrl: string }> }) => void;
};

export function AssistantComposer({
  addAttachmentLabel,
  disabled = false,
  loadingLabel,
  models,
  modelsLoading,
  modelLabel,
  modelIcon,
  sizeLabel,
  qualityLabel,
  sizeOptions,
  qualityOptions,
  imageSize,
  imageQuality,
  onImageSizeChange,
  onImageQualityChange,
  placeholder,
  removeAttachmentLabel,
  sendLabel,
  onInvalidAttachments,
  onSend,
}: AssistantComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (!models.some((item) => item.id === model)) setModel(models[0]?.id ?? '');
  }, [model, models]);

  const addFiles = (files: ArrayLike<File> | null) => {
    if (!files?.length) return;
    const remaining = 4 - attachments.length;
    if (remaining <= 0) { onInvalidAttachments('limit'); return; }
    const valid = Array.from(files).filter((file) => file.type.startsWith('image/') && file.size <= 10 * 1024 * 1024);
    const accepted = valid.slice(0, remaining);
    if (valid.length !== files.length) onInvalidAttachments('invalid');
    else if (accepted.length !== files.length) onInvalidAttachments('limit');
    const next = accepted.map((file) => {
      const src = URL.createObjectURL(file);
      objectUrlsRef.current.add(src);
      return { id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`, file, src };
    });
    setAttachments((current) => [...current, ...next]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => {
      if (attachment.id !== id) return true;
      URL.revokeObjectURL(attachment.src);
      objectUrlsRef.current.delete(attachment.src);
      return false;
    }));
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (disabled || !model || (!value && !attachments.length)) return;
    const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
      reader.readAsDataURL(file);
    });
    void Promise.all(attachments.map(async ({ file, src }) => ({ name: file.name, url: src, dataUrl: await readAsDataUrl(file) })))
      .then((nextAttachments) => {
        onSend({ text: value, model, size: imageSize, quality: imageQuality, attachments: nextAttachments });
        setText('');
        setAttachments([]);
      });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return <form className="aui-composer-root" onSubmit={submit}>
    <div
      data-slot="aui_composer-shell"
      data-dragging={dragging || undefined}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
    >
      <div className="aui-composer-attachments">{attachments.map((attachment) => <div className="aui-attachment-root" key={attachment.id}>
        <div className="aui-attachment-tile"><img className="aui-attachment-tile-image" src={attachment.src} alt={attachment.file.name} /></div>
        <button className="aui-attachment-tile-remove" type="button" onClick={() => removeAttachment(attachment.id)} aria-label={removeAttachmentLabel} title={removeAttachmentLabel}><X className="aui-attachment-remove-icon" /></button>
      </div>)}</div>
      <textarea className="aui-composer-input cp-sidebar-scrollbar" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={handleKeyDown} onPaste={(event) => { const files = Array.from(event.clipboardData.files); const clipboardImages = files.length ? files : Array.from(event.clipboardData.items).map((item) => item.kind === 'file' ? item.getAsFile() : null).filter((file): file is File => Boolean(file)); if (clipboardImages.length) { event.preventDefault(); addFiles(clipboardImages); } }} placeholder={placeholder} rows={1} />
      <div className="aui-composer-action-wrapper">
        <div className="aui-composer-action-start">
          <button className="aui-composer-add-attachment" type="button" onClick={() => inputRef.current?.click()} aria-label={addAttachmentLabel} title={addAttachmentLabel}><Plus className="aui-attachment-add-icon" /></button>
          <CustomSelect className="aui-model-picker" value={model} disabled={modelsLoading || !models.length || disabled} ariaLabel={modelLabel} placeholder={modelsLoading ? loadingLabel : modelLabel} icon={modelsLoading ? <SolnSpin label={loadingLabel} /> : modelIcon} menuPlacement="top" minMenuWidth={220} options={models.map((item) => ({ value: item.id, label: item.label }))} onChange={setModel} />
          <CustomSelect className="aui-image-option-picker" value={imageSize} disabled={disabled} ariaLabel={sizeLabel} menuPlacement="top" options={sizeOptions} onChange={(size) => onImageSizeChange(size as ImageSize)} />
          <CustomSelect className="aui-image-option-picker" value={imageQuality} disabled={disabled} ariaLabel={qualityLabel} menuPlacement="top" options={qualityOptions} onChange={(quality) => onImageQualityChange(quality as ImageQuality)} />
        </div>
        <button className="aui-composer-send" type="submit" disabled={disabled || !model || (!text.trim() && !attachments.length)} aria-label={sendLabel} title={sendLabel}><ArrowUp className="aui-composer-send-icon" /></button>
      </div>
      <input ref={inputRef} hidden type="file" accept="image/*" multiple onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
    </div>
  </form>;
}
