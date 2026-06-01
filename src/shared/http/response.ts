import { HttpStatus } from "./status";

export type SuccessResponse<T = unknown> = {
  success: { status: true; code: number | any; message: string };
  data: T | null;
  error: null;
};

export type ErrorResponse = {
  error: { status: false; code: number | any; message: string; field?: string; [key: string]: any };
  success: null;
  data: null;
};

export type FieldError = {
  field: string;
  message: string;
};

export type ValidationErrorResponse = {
  error: { status: false; code: number | any; message: string };
  success: null;
  data: null;
};

export function success<T>(message: string, data: T | null = null, code: number = HttpStatus.OK): SuccessResponse<T> {
  return { success: { status: true, code, message }, data, error: null };
}

export function error(code: number, message: string, field?: string, extra?: Record<string, any>): ErrorResponse {
  return { error: { status: false, code, message, ...(field ? { field } : {}), ...extra }, success: null, data: null };
}

export function serverError(error: any): ErrorResponse {
  return { error: { status: false, code: HttpStatus.INTERNAL_SERVER_ERROR, message: "Internal Server Error!" }, success: null, data: null };
}
