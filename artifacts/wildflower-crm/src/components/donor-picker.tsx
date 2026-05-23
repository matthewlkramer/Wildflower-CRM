export type DonorType = "individual" | "household" | "funding_entity";

export type DonorSelection = {
  type: DonorType;
  id: string;
  label?: string;
};

export function DonorPicker(_props: {
  value?: DonorSelection | null;
  onChange?: (next: DonorSelection | null) => void;
}): null {
  return null;
}
