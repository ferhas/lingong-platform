<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">帮助中心管理</h2>
        <p class="page-sub">零工端/企业端帮助文章的发布与维护</p>
      </div>
      <div class="page-actions">
        <el-button type="primary" :icon="Plus" @click="openCreate">新建文章</el-button>
        <el-button :icon="Refresh" circle aria-label="刷新" @click="load" />
      </div>
    </div>

    <div class="panel">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="id" label="ID" width="70" align="center" />
        <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
        <el-table-column prop="category" label="分类" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.category }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="受众" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="audienceTagType(row.audience)" size="small" effect="plain">
              {{ audienceText(row.audience) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sort" label="排序" width="80" align="center" />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'published' ? 'success' : 'info'" size="small">
              {{ row.status === 'published' ? '已发布' : '草稿' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.updated_at || row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right" align="center">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
            <el-button
              v-if="row.status === 'published'"
              type="warning"
              link
              size="small"
              @click="toggleStatus(row, 'draft')"
            >
              下 架
            </el-button>
            <el-button v-else type="success" link size="small" @click="toggleStatus(row, 'published')">
              发 布
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无帮助文章" :image-size="90" />
        </template>
      </el-table>
    </div>

    <!-- 新建/编辑对话框 -->
    <el-dialog
      v-model="dialog.visible"
      :title="dialog.id ? '编辑文章' : '新建文章'"
      width="640px"
      destroy-on-close
    >
      <el-form label-position="top">
        <el-row :gutter="14">
          <el-col :span="8">
            <el-form-item label="受众">
              <el-select v-model="dialog.audience" style="width: 100%">
                <el-option label="全部用户" value="all" />
                <el-option label="零工端" value="worker" />
                <el-option label="企业端" value="company" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="分类">
              <el-input v-model="dialog.category" maxlength="20" placeholder="例如：结算提现" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="排序（越大越靠前）">
              <el-input-number v-model="dialog.sort" :precision="0" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="标题（2-80字）">
          <el-input v-model="dialog.title" maxlength="80" show-word-limit placeholder="例如：提现多久到账？" />
        </el-form-item>
        <el-form-item label="正文（不少于10字）">
          <el-input
            v-model="dialog.content"
            type="textarea"
            :rows="10"
            :maxlength="5000"
            show-word-limit
            placeholder="支持纯文本，按段落换行"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="dialog.status">
            <el-radio value="published">立即发布</el-radio>
            <el-radio value="draft">存为草稿</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取 消</el-button>
        <el-button type="primary" :loading="dialog.submitting" @click="submit">
          {{ dialog.id ? '保存修改' : '创建文章' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Plus } from '@element-plus/icons-vue'
import { getHelpArticles, createHelpArticle, updateHelpArticle } from '../api/admin'
import { fmtTime } from '../utils/format'

const loading = ref(false)
const list = ref([])

function audienceText(a) {
  return { all: '全部用户', worker: '零工端', company: '企业端' }[a] || a
}

function audienceTagType(a) {
  return { all: 'info', worker: 'primary', company: 'warning' }[a] || 'info'
}

async function load() {
  loading.value = true
  try {
    const data = await getHelpArticles()
    list.value = data.list
  } catch {
    /* 错误已统一提示 */
  } finally {
    loading.value = false
  }
}

// —— 新建/编辑 ——
const dialog = reactive({
  visible: false,
  id: null,
  audience: 'all',
  category: '',
  title: '',
  content: '',
  sort: 0,
  status: 'published',
  submitting: false
})

function openCreate() {
  Object.assign(dialog, {
    id: null,
    audience: 'all',
    category: '',
    title: '',
    content: '',
    sort: 0,
    status: 'published',
    visible: true
  })
}

function openEdit(row) {
  Object.assign(dialog, {
    id: row.id,
    audience: row.audience,
    category: row.category,
    title: row.title,
    content: row.content,
    sort: row.sort,
    status: row.status,
    visible: true
  })
}

async function submit() {
  if (!dialog.category.trim()) {
    ElMessage.warning('请填写分类')
    return
  }
  if (dialog.title.trim().length < 2) {
    ElMessage.warning('标题不少于 2 个字')
    return
  }
  if (dialog.content.trim().length < 10) {
    ElMessage.warning('正文不少于 10 个字')
    return
  }
  const payload = {
    audience: dialog.audience,
    category: dialog.category.trim(),
    title: dialog.title.trim(),
    content: dialog.content.trim(),
    sort: dialog.sort || 0,
    status: dialog.status
  }
  dialog.submitting = true
  try {
    if (dialog.id) {
      await updateHelpArticle(dialog.id, payload)
      ElMessage.success('文章已更新')
    } else {
      await createHelpArticle(payload)
      ElMessage.success('文章已创建')
    }
    dialog.visible = false
    load()
  } catch {
    /* 错误已统一提示 */
  } finally {
    dialog.submitting = false
  }
}

async function toggleStatus(row, status) {
  try {
    await updateHelpArticle(row.id, { status })
    ElMessage.success(status === 'published' ? '文章已发布' : '文章已下架为草稿')
    load()
  } catch {
    /* 错误已统一提示 */
  }
}

onMounted(load)
</script>
