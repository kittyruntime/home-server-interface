<template>
  <RouterView v-slot="{ Component }">
    <Transition name="ui-fade" mode="out-in">
      <component :is="Component" style="--ui-dur: var(--dur-fast)" />
    </Transition>
  </RouterView>
</template>
