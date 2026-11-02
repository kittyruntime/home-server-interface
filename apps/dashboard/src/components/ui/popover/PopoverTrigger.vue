<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue"
import type { PrimitiveProps } from "../Primitive.vue"
import Primitive from "../Primitive.vue"
import { popoverKey } from "./context"

const props = withDefaults(defineProps<PrimitiveProps>(), { as: "button" })
const ctx = inject(popoverKey)!

const el = ref<InstanceType<typeof Primitive> | null>(null)
onMounted(() => ctx.setTrigger((el.value?.$el as HTMLElement | undefined) ?? null))
onBeforeUnmount(() => ctx.setTrigger(null))

const bindings = computed(() => ({
  "aria-haspopup": "dialog",
  "aria-expanded": ctx.open.value,
  "aria-controls": ctx.open.value ? ctx.contentId : undefined,
}))
</script>

<template>
  <Primitive
    ref="el"
    v-bind="{ ...bindings, ...(props.as === 'button' && !props.asChild ? { type: 'button' } : {}) }"
    :as="props.as"
    :as-child="props.asChild"
    @click="ctx.toggle"
  >
    <slot />
  </Primitive>
</template>
