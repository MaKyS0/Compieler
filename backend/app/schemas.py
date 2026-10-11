from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Language = Literal["python", "cpp", "javascript"]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str | None
    name: str
    is_guest: bool


class AuthOut(BaseModel):
    token: str
    user: UserOut


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=80)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or v.startswith("@") or v.endswith("@") or " " in v:
            raise ValueError("Enter a valid e-mail address")
        return v


class ProjectSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    entry: str | None = Field(default=None, max_length=300)
    cpp_std: Literal["c++17", "c++20", "c++23"] | None = None
    cpp_opt: Literal["-O0", "-O1", "-O2", "-O3"] | None = None
    args: str | None = Field(default=None, max_length=1000)


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    language: Language
    settings: dict
    created_at: datetime
    updated_at: datetime
    last_opened_at: datetime


class ProjectCreate(BaseModel):
    name: str = Field(default="Untitled", min_length=1, max_length=120)
    language: Language = "python"
    template: bool = True


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    language: Language | None = None
    settings: ProjectSettings | None = None


class FileWrite(BaseModel):
    path: str
    content: str = ""


class PathBody(BaseModel):
    path: str


class MoveBody(BaseModel):
    src: str
    dst: str


class FormatBody(BaseModel):
    language: Language
    content: str = Field(max_length=400_000)
    filename: str | None = None


class TreeEntry(BaseModel):
    path: str
    type: Literal["file", "dir"]
    size: int = 0
