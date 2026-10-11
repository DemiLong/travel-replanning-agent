"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { ArrowRight, MousePointerClick, X } from "lucide-react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

const exampleText = "我刚到上海博物馆东馆，比原计划晚了60分钟，本来我打算17:00去国金中心、19:00去外滩的，现在还来得及么？";

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
  const useExampleOnClose = useRef(false);

  return (
    <Drawer autoFocus open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button type="button" className="home-example-link">查看示例</button>
      </DrawerTrigger>
      <DrawerContent
        className="home-example-drawer"
        onCloseAutoFocus={event => {
          if (!useExampleOnClose.current) return;
          event.preventDefault();
          useExampleOnClose.current = false;
          onUseExample(exampleText);
        }}
      >
        <DrawerHeader className="home-example-header">
          <DrawerTitle>行程被打乱了，可以这样说</DrawerTitle>
          <DrawerDescription>从描述变化，到拿到新的安排，只需这几步。</DrawerDescription>
          <DrawerClose className="home-example-close" aria-label="关闭示例"><X size={20} /></DrawerClose>
        </DrawerHeader>

        <div className="home-example-scroll" data-vaul-no-drag>
          <ol className="home-example-steps">
            <li className="home-example-step">
              <h3><span className="home-example-number">1</span>说说原计划，发生了什么变化</h3>
              <p className="home-example-caption">写下你现在在哪儿、原本要去哪儿，以及晚了多久。</p>
              <div className="home-example-input-preview" role="img" aria-label={`示例输入：${exampleText} 点击帮我重新安排今天。`}>
                <div className="home-example-input">{exampleText}</div>
                <div className="home-example-preview-button">
                  帮我重新安排今天 <ArrowRight size={17} />
                  <ClickCue className="example-click-submit" />
                </div>
              </div>
              <p className="home-example-note">点击「帮我重新安排今天」，开始分析。</p>
            </li>

            <li className="home-example-step">
              <h3><span className="home-example-number">2</span>确认对应的地点</h3>
              <p className="home-example-caption">遇到同名地点，选择你要去的那个地址。图中以第一项为例。</p>
              <figure className="home-example-image">
                <Image src="/examples/confirm-location.png" alt="地点确认示例：国金中心有多个地点，第一项为上海ifc商场，地址为世纪大道8号。" width={786} height={1074} sizes="(max-width: 390px) calc(100vw - 40px), 350px" unoptimized />
                <ClickCue className="example-click-location" />
              </figure>
            </li>

            <li className="home-example-step">
              <h3><span className="home-example-number">3</span>查看调整方案，再决定是否接受</h3>
              <p className="home-example-caption">本例保留博物馆和外滩，移除国金中心，并重新安排时间和路线。</p>
              <figure className="home-example-image">
                <span className="home-example-result-label">示例结果</span>
                <Image src="/examples/adjusted-itinerary.png" alt="调整方案示例：保留2个原安排，16:15参观上海博物馆东馆，19:04去外滩，底部点击接受方案。" width={791} height={1232} sizes="(max-width: 390px) calc(100vw - 40px), 350px" unoptimized />
                <ClickCue className="example-click-accept" />
              </figure>
              <p className="home-example-note">示例中的时间仅作展示，实际方案会根据你的情况生成。</p>
            </li>
          </ol>
        </div>

        <div className="home-example-footer">
          <button type="button" className="primary full home-example-use" disabled={disabled} onClick={() => {
            useExampleOnClose.current = true;
            setOpen(false);
          }}>用这个示例试试 <ArrowRight size={17} /></button>
          <p>填入首页后，你可以修改，再提交。</p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
