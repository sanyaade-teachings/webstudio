import { WindowInfoIcon } from "@webstudio-is/icons/svg";
import {
  type WsComponentMeta,
  type WsComponentPropsMeta,
} from "@webstudio-is/sdk";
import { props } from "./__generated__/head-meta.props";

export const meta: WsComponentMeta = {
  icon: WindowInfoIcon,
  contentModel: {
    category: "none",
    children: [],
  },
};

export const propsMeta: WsComponentPropsMeta = {
  props,
  initialProps: ["name", "property", "content"],
};
