import type { Component } from 'vue'

export interface SectionNavItem<Id extends string> {
  id: Id
  label: string
  icon: Component
  /** Items sharing a group sit under one label; consecutive items only. */
  group?: string
}
