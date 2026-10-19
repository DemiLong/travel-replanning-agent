"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, MousePointerClick, X } from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

const exampleText = "现在是下午4点，我刚到上海博物馆东馆，比原计划晚了60分钟，本来我打算17:00去国金中心、19:00去外滩的，现在还来得及么？";

const STEP_COUNT = 3;

function ClickCue({ className = "" }: { className?: string }) {
  return <span className={`example-click-cue ${className}`} aria-hidden="true"><MousePointerClick size={25} strokeWidth={2.1} /></span>;
}

export function HomeExampleDrawer({
  disabled = false,
  onUseExample,
}: {
  disabled?: boolean;
  onUseExample: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const useExampleOnClose = useRef(false);

  useEffect(() => {
    if (!open) return;
    const node = carouselRef.current;
    if (node) node.scrollTo({ left: 0 });
  }, [open]);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) setActive(0);
    setOpen(nextOpen);
  }

  function handleScroll() {
    const node = carouselRef.current;
    if (!node) return;
    const width = node.clientWidth;
    if (!width) return;
    const index = Math.max(0, Math.min(STEP_COUNT - 1, Math.round(node.scrollLeft / width)));
    setActive(index);
  }

  function goTo(index: number) {
    const node = carouselRef.current;
    if (!node) return;
    node.scrollTo({ left: index * node.clientWidth, behavior: "smooth" });
  }

  return (
    <Drawer autoFocus open={open} onOpenChange={handleOpenChange}>
      <DrawerTrigger asChild>
        <button type="button" className="home-example-link">查看示例</button>
      </DrawerTrigger>
      <DrawerContent
        className="home-example-drawer"
        aria-label="行程示例"
        onCloseAutoFocus={event => {
          if (!useExampleOnClose.current) return;
          event.preventDefault();
          useExampleOnClose.current = false;
          onUseExample(exampleText);
        }}
      >
        <div className="home-example-topbar">
          <DrawerTitle className="sr-only">行程示例</DrawerTitle>
          <DrawerClose className="home-example-close" aria-label="关闭示例"><X size={20} /></DrawerClose>
        </div>

        <div
          className="home-example-carousel"
          data-vaul-no-drag
          ref={carouselRef}
          onScroll={handleScroll}
        >
          <section className="home-example-page">
            <h3><span className="home-example-number">1</span>说说原计划，发生了什么变化</h3>
            <div className="home-example-page-body">
              <figure className="home-example-image">
                <Image src="/examples/describe-change.png" alt={`示例输入：${exampleText} 点击帮我重新安排今天。`} width={791} height={540} sizes="(max-width: 390px) calc(100vw - 40px), 350px" unoptimized />
                <ClickCue className="example-click-submit" />
              </figure>
            </div>
          </section>

          <section className="home-example-page">
            <h3><span className="home-example-number">2</span>确认对应的地点</h3>
            <div className="home-example-page-body">
              <figure className="home-example-image">
                <Image src="/examples/confirm-location.png" alt="地点确认示例：国金中心有多个地点，候选为上海ifc商场、国际金融中心和国金中心2期。" width={793} height={648} sizes="(max-width: 390px) calc(100vw - 40px), 350px" unoptimized />
                <ClickCue className="example-click-location" />
              </figure>
            </div>
          </section>

          <section className="home-example-page">
            <h3><span className="home-example-number">3</span>查看调整方案，再决定是否接受</h3>
            <div className="home-example-page-body">
              <figure className="home-example-image">
                <Image src="/examples/adjusted-itinerary.png" alt="调整方案示例：保留2个原安排，16:15参观上海博物馆东馆，19:04去外滩，底部点击接受方案。" width={791} height={1097} sizes="(max-width: 390px) calc(100vw - 40px), 350px" unoptimized />
                <ClickCue className="example-click-accept" />
              </figure>
            </div>
          </section>
        </div>

        <div className="home-example-dots" role="tablist" aria-label="示例步骤">
          {[0, 1, 2].map(index => (
            <button
              key={index}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-label={`第 ${index + 1} 步`}
              className={`home-example-dot${index === active ? " is-active" : ""}`}
              onClick={() => goTo(index)}
            />
          ))}
        </div>

        <div className="home-example-footer">
          <button type="button" className="primary full home-example-use" disabled={disabled} onClick={() => {
            useExampleOnClose.current = true;
            setOpen(false);
          }}>用这个示例试试 <ArrowRight size={17} /></button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
