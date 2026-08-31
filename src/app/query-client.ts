import { QueryClient } from "@tanstack/react-query";
export const makeQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: true }, mutations: { retry: false } } });
