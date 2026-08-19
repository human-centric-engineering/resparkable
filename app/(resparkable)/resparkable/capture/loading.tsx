import { Skeleton, SkeletonBlock } from '@/components/resparkable/ui/skeleton';

export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl">
      <SkeletonBlock label="Loading capture">
        <Skeleton className="h-[50vh] w-full" />
      </SkeletonBlock>
    </div>
  );
}
