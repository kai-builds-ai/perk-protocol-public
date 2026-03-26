import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeHighlight from 'rehype-highlight';
import { getDocBySlug, getAllSlugs } from '@/lib/docs';
import { getPrevNext } from '@/lib/navigation';
import { PrevNext } from '@/components/PrevNext';

const mdxComponents = {
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="table-wrapper">
      <table {...props} />
    </div>
  ),
};

interface PageProps {
  params: { slug: string };
}

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: PageProps) {
  const doc = getDocBySlug(params.slug);
  if (!doc) return {};
  return {
    title: `${doc.title} — Perk Docs`,
    description: `Perk Protocol documentation: ${doc.title}`,
  };
}

export default function DocPage({ params }: PageProps) {
  const doc = getDocBySlug(params.slug);
  if (!doc) notFound();

  const { prev, next } = getPrevNext(params.slug);

  // Rewrite internal doc links: (XX-name.md) → (/slug)
  const content = doc.content
    .replace(/\(01-introduction\.md\)/g, '(/introduction)')
    .replace(/\(02-getting-started\.md\)/g, '(/getting-started)')
    .replace(/\(03-trading\.md\)/g, '(/trading)')
    .replace(/\(04-market-creation\.md\)/g, '(/market-creation)')
    .replace(/\(05-architecture\.md\)/g, '(/architecture)')
    .replace(/\(06-perkoracle\.md\)/g, '(/perkoracle)')
    .replace(/\(07-security\.md\)/g, '(/security)')
    .replace(/\(08-sdk\.md\)/g, '(/sdk)')
    .replace(/\(09-fees\.md\)/g, '(/fees)')
    .replace(/\(10-faq\.md\)/g, '(/faq)');

  return (
    <article className="doc-content">
      <MDXRemote
        source={content}
        components={mdxComponents}
        options={{
          mdxOptions: {
            remarkPlugins: [remarkGfm],
            rehypePlugins: [
              rehypeSlug,
              [rehypeAutolinkHeadings, {
                behavior: 'append',
                properties: { className: ['icon-link'], ariaHidden: true },
                content: { type: 'text', value: '#' },
              }],
              rehypeHighlight,
            ],
          },
        }}
      />
      <PrevNext prev={prev} next={next} />
    </article>
  );
}
