export interface PromptImage {
  type: 'image'
  mimeType: string
  data: string
  name?: string
}

export interface PreparedAttachment {
  path: string
  name: string
  size: number
  kind: 'image' | 'text' | 'unsupported'
  text: string
  images: PromptImage[]
  error: string | null
  status: 'preparing' | 'ready' | 'error'
}

export type AttachmentPreparation = Omit<PreparedAttachment, 'status'>
