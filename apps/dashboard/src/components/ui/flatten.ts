import type { VNode } from "vue"
import { createTextVNode, Fragment } from "vue"

/**
 * Slot content as a flat list of vnodes. A fragment is replaced by its
 * children; a string or number child becomes a text vnode, and null, undefined
 * and booleans (what `v-if` leaves behind) are dropped, as Reka's did.
 */
export function flatten(nodes: unknown): VNode[] {
  if (!Array.isArray(nodes))
    return nodes === undefined || nodes === null || typeof nodes === "boolean" ? [] : flatten([nodes])
  return nodes.flatMap((node): VNode[] => {
    if (node === undefined || node === null || typeof node === "boolean")
      return []
    if (typeof node === "string" || typeof node === "number")
      return [createTextVNode(String(node))]
    if (Array.isArray(node))
      return flatten(node)
    const vnode = node as VNode
    return vnode.type === Fragment ? flatten(vnode.children) : [vnode]
  })
}
