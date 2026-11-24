import { esc } from "./xml.ts";

// ---------- tiny XML builder ----------
export type Node = { open: string; children: (Node | string)[]; close: string } | string;
export const obj = (type: string, id: string | null, children: (Node | string)[]): Node => ({
  open: `<Object${id ? ` id="${esc(id)}"` : ""} type="${type}">`,
  children,
  close: "</Object>",
});
export const comps = (prop: string, children: Node[]): Node | null => (children.length ? { open: `<Components property="${prop}">`, children, close: "</Components>" } : null);
export const str = (prop: string, v: string | null | undefined): Node | null => (v ? { open: `<Data property="${prop}">`, children: [`<String>${esc(v)}</String>`], close: "</Data>" } : null);
export const mls = (prop: string, v: string | null | undefined): Node | null =>
  v
    ? {
        open: `<Data property="${prop}">`,
        children: [
          {
            open: `<AggregatedDataValue type="Core/DataTypes.MultiLanguageString">`,
            children: [
              {
                open: `<Data property="SingleLanguageStrings">`,
                children: [
                  {
                    open: `<AggregatedDataValue type="Core/DataTypes.SingleLanguageString">`,
                    children: [str("Language", "en")!, str("Value", v)!],
                    close: "</AggregatedDataValue>",
                  },
                ],
                close: "</Data>",
              },
            ],
            close: "</AggregatedDataValue>",
          },
        ],
        close: "</Data>",
      }
    : null;
export const ref = (prop: string, ...ids: (string | null | undefined)[]) => {
  const list = ids.filter(Boolean) as string[];
  return list.length ? `<References objects="${list.map((i) => `#${esc(i)}`).join(" ")}" property="${prop}"/>` : null;
};
export const nn = <T,>(xs: (T | null | undefined)[]) => xs.filter((x): x is T => x != null);

export function render(n: Node, ind = 0): string {
  const pad = "  ".repeat(ind);
  if (typeof n === "string") return pad + n;
  if (!n.children.length) return pad + n.open.replace(/>$/, "/>");
  return [pad + n.open, ...n.children.map((c) => render(c, ind + 1)), pad + n.close].join("\n");
}


// ---------- Core/Diagram value helpers ----------
const num = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(Math.round(v * 1000) / 1000));
export const dbl = (prop: string, v: number): Node => `<Data property="${prop}"><Double>${num(v)}</Double></Data>`;
export const bool = (prop: string, v: boolean): Node => `<Data property="${prop}"><Boolean>${v}</Boolean></Data>`;
export const enumRef = (prop: string, v: string): Node => `<Data property="${prop}"><DataReference data="${v}"/></Data>`;
export const point = (x: number, y: number) =>
  `<AggregatedDataValue type="Core/Diagram.Point"><Data property="X"><Double>${num(x)}</Double></Data><Data property="Y"><Double>${num(y)}</Double></Data></AggregatedDataValue>`;
export const color = (c: [number, number, number]) =>
  `<AggregatedDataValue type="Core/Diagram.Color"><Data property="B"><Integer>${c[2]}</Integer></Data><Data property="G"><Integer>${c[1]}</Integer></Data><Data property="R"><Integer>${c[0]}</Integer></Data></AggregatedDataValue>`;
export const stroke = (c: [number, number, number], w: number, dash = "Solid") =>
  `<AggregatedDataValue type="Core/Diagram.Stroke"><Data property="Color">${color(c)}</Data><Data property="DashStyle"><DataReference data="Core/Diagram.DashStyle.${dash}"/></Data><Data property="Width"><Double>${num(w)}</Double></Data></AggregatedDataValue>`;
export const data = (prop: string, ...values: string[]): Node => ({ open: `<Data property="${prop}">`, children: values, close: "</Data>" });
