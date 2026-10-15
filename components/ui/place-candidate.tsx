import { MapPin } from "lucide-react";

export function PlaceCandidateContent({ name, description }: { name: string; description?: string }) {
  const category = name.match(/[（(](地铁站|公交站|公交车站|火车站|高铁站|客运站|机场|航站楼)[）)]/);
  const title = category ? name.replace(category[0], "").trim() || name : name;
  return (
    <span className="place-candidate-content">
      <span className="place-candidate-marker" aria-hidden="true"><MapPin size={17} strokeWidth={1.7} /></span>
      <span className="place-candidate-copy">
        <span className="place-candidate-title"><strong className="place-candidate-name">{title}</strong>{category && <span className="place-candidate-kind">{category[1]}</span>}</span>
        {description && <span className="place-candidate-description">{description}</span>}
      </span>
    </span>
  );
}

export const PLACE_CANDIDATE_LIMIT = 5;

export function locationConfirmationTitle(question: string, fallbackName?: string | null) {
  const name = question.match(/[“「『"']([^”」』"']+)[”」』"']/)?.[1] || fallbackName?.trim();
  return name ? `请确认${name}位置` : "请确认位置";
}
