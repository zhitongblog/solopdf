<script setup lang="ts">
/**
 * Open-password: set one, or export a copy without one.
 *
 * Removing a password requires knowing it — SoloPDF already holds the session
 * password for a file you opened, and this panel never tries to guess. That
 * is a deliberate limit, and the UI says so rather than leaving people to
 * wonder why it "doesn't work" on someone else's document.
 */
import { computed, ref } from 'vue'
import { store } from '../../store'
import { docOps, pickSavePath } from '../../platform/docops'
import { t } from '../../i18n'

const emit = defineEmits<{ toast: [msg: string]; open: [path: string] }>()

const tab = computed(() => store.activeTab)
const busy = ref(false)

const newPassword = ref('')
const confirmPassword = ref('')
const ownerPassword = ref('')
const currentPassword = ref('')

const mismatch = computed(
  () => !!confirmPassword.value && newPassword.value !== confirmPassword.value,
)

async function setPassword(): Promise<void> {
  const src = tab.value?.path
  if (!src || !newPassword.value || mismatch.value) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-protected.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.setPassword(
      src, dest, currentPassword.value || null, newPassword.value, ownerPassword.value,
    )
    newPassword.value = ''
    confirmPassword.value = ''
    ownerPassword.value = ''
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}

async function removePassword(): Promise<void> {
  const src = tab.value?.path
  if (!src || !currentPassword.value) return
  const suggested = (tab.value?.name ?? 'document').replace(/\.pdf$/i, '') + '-unlocked.pdf'
  const dest = await pickSavePath(suggested, 'pdf')
  if (dest === undefined) return
  busy.value = true
  try {
    const out = await docOps.removePassword(src, dest, currentPassword.value)
    emit('toast', t('dt.saved', { file: out.split('/').pop() ?? out }))
    emit('open', out)
  } catch (err) {
    emit('toast', String((err as Error).message ?? err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="dt-section">
    <p class="dt-hint" v-if="tab?.encrypted">{{ t('dt.se.isEncrypted') }}</p>

    <h4>{{ t('dt.se.setTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.setHint') }}</p>
    <div class="dt-field" v-if="tab?.encrypted">
      <label>{{ t('dt.se.current') }}</label>
      <input type="password" v-model="currentPassword" autocomplete="off" />
    </div>
    <div class="dt-field">
      <label>{{ t('dt.se.newPw') }}</label>
      <input type="password" v-model="newPassword" autocomplete="new-password" />
    </div>
    <div class="dt-field">
      <label>{{ t('dt.se.confirm') }}</label>
      <input type="password" v-model="confirmPassword" autocomplete="new-password" />
    </div>
    <p class="dt-warn" v-if="mismatch">{{ t('dt.se.mismatch') }}</p>
    <div class="dt-field">
      <label>{{ t('dt.se.owner') }}</label>
      <input type="password" v-model="ownerPassword" autocomplete="off" :placeholder="t('dt.se.ownerHint')" />
    </div>
    <div class="dt-actions">
      <button class="primary" :disabled="busy || !newPassword || mismatch" @click="setPassword">
        {{ busy ? t('dt.working') : t('dt.se.doSet') }}
      </button>
    </div>

    <h4>{{ t('dt.se.removeTitle') }}</h4>
    <p class="dt-hint">{{ t('dt.se.removeHint') }}</p>
    <div class="dt-field">
      <label>{{ t('dt.se.current') }}</label>
      <input type="password" v-model="currentPassword" autocomplete="off" />
    </div>
    <div class="dt-actions">
      <button class="primary" :disabled="busy || !currentPassword" @click="removePassword">
        {{ busy ? t('dt.working') : t('dt.se.doRemove') }}
      </button>
    </div>
  </div>
</template>
