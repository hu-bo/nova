import { parser } from "@lezer/markdown";

export const specDesignAcceptanceHeading = "验收标准";
export const specDesignSections = ["目标", "功能", "实现方案", specDesignAcceptanceHeading] as const;
const requirementsAcceptanceHeading = "验收条件";

export function parseSpecDocument(
  markdown: string,
  acceptanceHeading: typeof specDesignAcceptanceHeading | typeof requirementsAcceptanceHeading = specDesignAcceptanceHeading,
) {
  const sections: { title: string; hasContent: boolean }[] = [];
  const acceptanceHeadings: { id?: string; title: string; from: number; hasContent: boolean }[] = [];
  let section: (typeof sections)[number] | undefined;
  let criterion: (typeof acceptanceHeadings)[number] | undefined;

  const document = parser.parse(markdown).topNode;
  for (let node = document.firstChild; node; node = node.nextSibling) {
    const heading = /^ATXHeading([1-6])$/.exec(node.name);
    if (!heading) {
      if (node.name === "SetextHeading1" || node.name === "SetextHeading2") {
        section = undefined;
        criterion = undefined;
      } else if (node.name !== "HorizontalRule" && node.name !== "CommentBlock") {
        if (section) section.hasContent = true;
        if (criterion) criterion.hasContent = true;
      }
      continue;
    }

    const title = markdown
      .slice(node.from, node.to)
      .replace(/^#+[ \t]*/, "")
      .replace(/[ \t]+#+[ \t]*$/, "")
      .trim();
    if (heading[1] === "1") {
      section = undefined;
      criterion = undefined;
    } else if (heading[1] === "2") {
      section = { title, hasContent: false };
      sections.push(section);
      criterion = undefined;
    } else if (heading[1] === "3" && section?.title === acceptanceHeading) {
      const match = /^(AC-\d{2,})(?:\s+(.*))?$/.exec(title);
      const criterionTitle = match?.[2] ?? "";
      criterion = {
        ...(match?.[1] ? { id: match[1] } : {}),
        title: criterionTitle,
        from: node.from,
        hasContent: Boolean(criterionTitle),
      };
      acceptanceHeadings.push(criterion);
    }
  }
  return { sections, acceptanceHeadings };
}

export function parseAcceptanceCriteria(
  markdown: string,
  acceptanceHeading?: Parameters<typeof parseSpecDocument>[1],
) {
  return parseSpecDocument(markdown, acceptanceHeading).acceptanceHeadings.flatMap(({ id, title, from }) =>
    id ? [{ id, title, from }] : [],
  );
}

export function specAcceptanceCriteria(spec: {
  requirementsMd: string;
  designMd: string | null;
  revision: number;
  reviews: { design?: { revision: number; criteriaSource?: "design" | undefined } | undefined };
}) {
  const review = spec.reviews.design;
  // Earlier confirmed designs used the requirements document for task checks.
  if (review?.revision === spec.revision && !review.criteriaSource)
    return parseAcceptanceCriteria(spec.requirementsMd, requirementsAcceptanceHeading);
  return parseAcceptanceCriteria(spec.designMd ?? "");
}
