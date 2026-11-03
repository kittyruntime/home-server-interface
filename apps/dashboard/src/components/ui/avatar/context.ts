import type { InjectionKey, Ref } from "vue"

export type ImageStatus = "idle" | "loading" | "loaded" | "error"

export interface AvatarContext {
  status: Ref<ImageStatus>
}

export const avatarKey: InjectionKey<AvatarContext> = Symbol("avatar")
