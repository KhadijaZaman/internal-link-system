import { useEffect } from "react";
import { useLocation } from "wouter";
import { useGetSession, getGetSessionQueryKey } from "@workspace/api-client-react";
import { Spinner } from "@/components/ui/spinner";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();
  const { data: session, isLoading } = useGetSession({
    query: {
      retry: false,
      queryKey: getGetSessionQueryKey(),
    },
  });

  useEffect(() => {
    if (!isLoading && (!session || !session.authenticated)) {
      setLocation("/login");
    }
  }, [session, isLoading, setLocation]);

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!session?.authenticated) {
    return null;
  }

  return <>{children}</>;
}
