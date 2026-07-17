import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  /** Lazily produce the text to copy, so the current data is captured at click time. */
  getText: () => string;
  label?: string;
  disabled?: boolean;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  toastTitle?: string;
}

export function CopyButton({
  getText,
  label = "Copy",
  disabled,
  size = "sm",
  variant = "outline",
  className,
  toastTitle = "Copied to clipboard",
}: CopyButtonProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    const text = getText();
    if (!text) {
      toast({ title: "Nothing to copy" });
      return;
    }
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      toast({ title: toastTitle });
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={onClick}
      disabled={disabled}
      className={cn(className)}
    >
      {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
      {label}
    </Button>
  );
}
