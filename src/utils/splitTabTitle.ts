export const SPLIT_TAB_TITLE_MODES = [
  "titleCreatorYear",
  "creatorYearTitle",
  "attachmentTitle",
  "filename",
] as const;

export type SplitTabsTitleMode = (typeof SPLIT_TAB_TITLE_MODES)[number];

export interface SplitTabTitleData {
  itemID?: number;
  kind: "attachment" | "note";
  displayTitle: string;
  attachmentFilename?: string | null;
  parentTitle?: string | false | null;
  firstCreator?: string | null;
  year?: string | null;
  isPrimaryAttachment?: boolean;
}

function normalizeYear(year?: string | null) {
  if (!year || year === "0000") {
    return "";
  }
  return year;
}

export function formatSplitTabTitleFromData(
  data: SplitTabTitleData,
  mode: SplitTabsTitleMode,
): string {
  if (data.kind === "note") {
    return data.displayTitle;
  }

  if (mode === "attachmentTitle") {
    return data.displayTitle;
  }

  if (mode === "filename") {
    return data.attachmentFilename || data.displayTitle;
  }

  if (data.parentTitle === undefined || data.parentTitle === null) {
    return data.displayTitle;
  }

  const creator = data.firstCreator || "";
  const year = normalizeYear(data.year);
  let parts: Array<string | false>;
  if (data.isPrimaryAttachment) {
    if (mode === "creatorYearTitle" && creator) {
      parts = [creator, year, data.parentTitle];
    } else {
      parts = [data.parentTitle, creator, year];
    }
  } else if (mode === "creatorYearTitle" && creator) {
    parts = [creator, year, data.displayTitle];
  } else {
    parts = [data.displayTitle, creator, year];
  }

  return parts.filter(Boolean).join(" - ");
}

export function formatSplitViewTabTitleFromData(
  leftData: SplitTabTitleData,
  rightData: SplitTabTitleData,
  mode: SplitTabsTitleMode,
) {
  const leftTitle = formatSplitTabTitleFromData(leftData, mode);
  const rightTitle = formatSplitTabTitleFromData(rightData, mode);

  if (
    leftData.kind === "attachment" &&
    rightData.kind === "attachment" &&
    leftData.itemID !== undefined &&
    leftData.itemID === rightData.itemID
  ) {
    return leftTitle;
  }

  return `${leftTitle} | ${rightTitle}`;
}

async function getSplitTabTitleDataForItem(
  item: Zotero.Item,
): Promise<SplitTabTitleData> {
  if (!item.isAttachment() && !item.isNote()) {
    throw new Error("Can only get tab title for attachments and notes");
  }

  if (item.isNote()) {
    return {
      itemID: item.id,
      kind: "note",
      displayTitle: item.getDisplayTitle(),
    };
  }

  const parentItem = item.parentItem;
  if (!parentItem) {
    return {
      itemID: item.id,
      kind: "attachment",
      displayTitle: item.getDisplayTitle(),
      attachmentFilename: item.attachmentFilename,
    };
  }

  const attachment = await parentItem.getBestAttachment();
  const isPrimaryAttachment = !!attachment && attachment.id === item.id;
  const creator = parentItem.getField("firstCreator", Zotero.isWin);

  return {
    itemID: item.id,
    kind: "attachment",
    displayTitle: item.getDisplayTitle(),
    attachmentFilename: item.attachmentFilename,
    parentTitle: isPrimaryAttachment ? parentItem.getDisplayTitle() : false,
    firstCreator: creator,
    year: parentItem.getField("year"),
    isPrimaryAttachment,
  };
}

export async function getSplitTabTitleForItem(
  item: Zotero.Item,
  mode: SplitTabsTitleMode,
) {
  const data = await getSplitTabTitleDataForItem(item);
  return formatSplitTabTitleFromData(data, mode);
}

export async function getSplitViewTabTitleForItems(
  leftItem: Zotero.Item,
  rightItem: Zotero.Item,
  mode: SplitTabsTitleMode,
) {
  const [leftData, rightData] = await Promise.all([
    getSplitTabTitleDataForItem(leftItem),
    getSplitTabTitleDataForItem(rightItem),
  ]);

  return formatSplitViewTabTitleFromData(leftData, rightData, mode);
}
