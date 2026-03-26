import fs from 'fs';
import path from 'path';
import { navigation } from './navigation';

const contentDir = path.join(process.cwd(), 'content');

export function getDocBySlug(slug: string): { content: string; title: string } | null {
  const nav = navigation.find((item) => item.slug === slug);
  if (!nav) return null;

  const filePath = path.join(contentDir, nav.file);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  return { content: raw, title: nav.title };
}

export function getAllSlugs(): string[] {
  return navigation.map((item) => item.slug);
}
