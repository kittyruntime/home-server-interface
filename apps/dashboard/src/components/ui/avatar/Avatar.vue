<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ImageStatus } from "./context"
import { provide, ref } from "vue"
import { cn } from "@/lib/utils"
import { avatarKey } from "./context"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()

// AvatarImage reports its loading status here, AvatarFallback shows until "loaded"
provide(avatarKey, { status: ref<ImageStatus>("idle") })
</script>

<template>
  <span
    data-slot="avatar"
    :class="cn('avatar size-8 shrink-0 overflow-hidden rounded-full', props.class)"
  >
    <slot />
  </span>
</template>
