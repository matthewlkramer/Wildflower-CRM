import * as React from "react";
import { Plus } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * Compact "+" add button used immediately to the right of a list-page title.
 * Forwards its ref + props so it can be the child of a Radix `DialogTrigger
 * asChild` (which clones it to wire up the open handler). `label` drives both
 * the accessible name and the hover tooltip since the button is icon-only.
 */
export const AddIconButton = React.forwardRef<
  HTMLButtonElement,
  ButtonProps & { label: string }
>(({ label, className, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    size="icon"
    className={className ?? "h-8 w-8 shrink-0"}
    aria-label={label}
    title={label}
    {...props}
  >
    <Plus className="h-4 w-4" />
  </Button>
));
AddIconButton.displayName = "AddIconButton";
