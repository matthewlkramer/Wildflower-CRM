export type EditField<K extends string> = {
  kind: string;
  key: K;
  label: string;
  value?: unknown;
};

export function EditDialog<T extends Record<string, unknown>>(_props: {
  fields?: ReadonlyArray<EditField<Extract<keyof T, string>>>;
  onSubmit?: (values: Partial<T>) => Promise<void> | void;
}): null {
  return null;
}
