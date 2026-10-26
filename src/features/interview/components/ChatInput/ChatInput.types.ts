export type ChatInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sendDisabled: boolean;
};
