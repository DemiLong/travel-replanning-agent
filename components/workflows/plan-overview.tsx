"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function PlanOverview({ text }: { text: string }) {
  const id = useId();
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setContentHeight(content.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  return <section className="plan-summary-overview" aria-label="整体取舍">
    <div id={id} className="plan-overview-content" aria-hidden={!expanded} style={{ height: `${expanded ? contentHeight : 0}px` }}>
      <p ref={contentRef}>{text}</p>
    </div>
    <button type="button" className="plan-overview-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      {expanded ? "收起说明" : "展开说明"}<ChevronDown size={13} aria-hidden="true" />
    </button>
  </section>;
}
