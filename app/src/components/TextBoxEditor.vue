<script setup lang="ts">
/**
 * In-place editor for a text box: a bare textarea laid over the box, in the
 * box's own font size and colour, so what you type is what lands on the page.
 * Grows downward as you type. Blur or ⌘/Ctrl+Enter commits, Esc discards.
 */
import { nextTick, onMounted, ref } from 'vue'

const props = defineProps<{
  left: number
  top: number
  width: number
  minHeight: number
  /** px */
  fontSize: number
  color: string
  text: string
}>()
const emit = defineEmits<{
  commit: [r: { text: string; width: number; height: number }]
  cancel: []
}>()

const el = ref<HTMLTextAreaElement>()
const value = ref(props.text)
let done = false

function grow(): void {
  const ta = el.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${Math.max(props.minHeight, ta.scrollHeight + 2)}px`
}

function commit(): void {
  if (done) return
  done = true
  const ta = el.value
  emit('commit', {
    text: value.value.replace(/\s+$/, ''),
    width: ta?.offsetWidth ?? props.width,
    height: ta?.offsetHeight ?? props.minHeight,
  })
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    done = true
    emit('cancel')
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    commit()
  }
}

onMounted(async () => {
  await nextTick()
  grow()
  el.value?.focus()
  // caret at the end when editing an existing box
  const n = value.value.length
  el.value?.setSelectionRange(n, n)
})
</script>

<template>
  <textarea
    ref="el"
    v-model="value"
    class="tb-editor"
    :style="{
      left: left + 'px', top: top + 'px', width: width + 'px', minHeight: minHeight + 'px',
      fontSize: fontSize + 'px', color,
    }"
    @input="grow"
    @keydown="onKey"
    @blur="commit"
    @pointerdown.stop
  ></textarea>
</template>
