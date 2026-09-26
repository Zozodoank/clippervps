import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const draftsFilePath = process.env.DRAFTS_FILE_PATH || path.join(__dirname, '..', '..', 'drafts.json');

const router = express.Router();

function getDrafts() {
  if (!fs.existsSync(draftsFilePath)) {
    return [];
  }
  try {
    const data = fs.readFileSync(draftsFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading drafts file:', error);
    return [];
  }
}

function saveDrafts(drafts) {
  try {
    fs.writeFileSync(draftsFilePath, JSON.stringify(drafts, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing drafts file:', error);
  }
}

// GET all drafts
router.get('/', (req, res) => {
  const drafts = getDrafts();
  res.json({ success: true, drafts });
});

// POST save a new draft
router.post('/', (req, res) => {
  const draftData = req.body;
  if (!draftData) {
    return res.status(400).json({ error: 'Data draft kosong.' });
  }

  const drafts = getDrafts();
  const newDraft = {
    id: `draft_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    createdAt: new Date().toISOString(),
    ...draftData
  };
  
  drafts.push(newDraft);
  saveDrafts(drafts);
  
  res.json({ success: true, draft: newDraft });
});

// DELETE a draft
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const drafts = getDrafts();
  
  const initialLength = drafts.length;
  const filteredDrafts = drafts.filter(d => d.id !== id);
  
  if (filteredDrafts.length === initialLength) {
    return res.status(404).json({ error: 'Draft tidak ditemukan.' });
  }
  
  saveDrafts(filteredDrafts);
  res.json({ success: true, deletedId: id });
});

export default router;
