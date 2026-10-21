import type { JSX } from "solid-js";

interface Props {
  label: string;
  children: JSX.Element;
}

export default function TimeSection(props: Props) {
  return (
    <section class="mb-6">
      <div class="flex w-full items-center gap-2 py-1">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {props.label}
        </span>
        <span class="h-px flex-1 bg-border" />
      </div>
      <div class="pt-3 timeline-section-content">
        {props.children}
      </div>
    </section>
  );
}
